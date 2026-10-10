#!/bin/bash

set -e

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

echo "=== Phase 4: Frame Conversion ==="
echo "Task ID: $TASK_ID"
echo "AI Account ID: $AI_ACCOUNT_ID"

WORK_DIR="/tmp/$TASK_ID"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

LOG_FILE="/tmp/convert-frames.log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

if [ -z "$AI_API_KEY" ]; then
    echo "Error: AI_API_KEY not set"
    exit 1
fi

echo "Downloading analysis result..."
aws s3 cp "s3://$R2_BUCKET_NAME/${TASK_ID}/analysis_result.json" "./analysis_result.json" \
    --endpoint-url "$R2_ENDPOINT_URL"

RESULT=$(cat ./analysis_result.json)
SHOT_COUNT=$(echo "$RESULT" | jq -r '.storyboards | length')

echo "Found $SHOT_COUNT shots to process"

if [ "$SHOT_COUNT" -eq 0 ]; then
    echo "Error: No shots found in analysis_result.json"
    exit 1
fi

TOTAL_FRAMES=$((SHOT_COUNT * 2))

mkdir -p ./ai_shot_frames
rm -rf ./locks
mkdir -p ./locks
rm -f ./bad_accounts.txt
rm -f ./frame_results.txt

ACCOUNT_COUNT=1
if [ -n "$AI_ACCOUNTS" ]; then
    AI_ACCOUNTS=$(echo "$AI_ACCOUNTS" | jq -c '[.[] | select(.api_type == "image")]')
    ACCOUNT_COUNT=$(echo "$AI_ACCOUNTS" | jq -r '. | length')
fi

MAX_CONCURRENT=${MAX_CONCURRENT:-2}
EFFECTIVE_CONCURRENCY=$(( ACCOUNT_COUNT < MAX_CONCURRENT ? ACCOUNT_COUNT : MAX_CONCURRENT ))

echo "Available AI accounts: $ACCOUNT_COUNT"
echo "Max concurrent (from GitHub accounts): $MAX_CONCURRENT"
echo "Effective concurrency: $EFFECTIVE_CONCURRENCY"

notify_subtask() {
    local action="$1"
    local shot_index="$2"
    local frame_type="$3"
    local status="$4"
    local output_path="$5"
    local error_msg="$6"
    
    if [ -z "$CALLBACK_URL" ]; then
        return
    fi
    
    local subtask_index=$((shot_index * 2 + (frame_type == "first" ? 0 : 1)))
    local input_path="${TASK_ID}/shot_frames/shot_${shot_index}_${frame_type}.jpg"
    
    local payload="{\"task_id\":\"$TASK_ID\",\"phase\":\"CONVERT_FRAMES\",\"subtask_index\":$subtask_index"
    
    if [ "$action" = "create" ]; then
        payload="$payload,\"subtask_type\":\"frame_${frame_type}\",\"input_path\":\"$input_path\",\"metadata\":\"{\\\"shot_index\\\":${shot_index},\\\"frame_type\\\":\\\"${frame_type}\\\"}\"}"
        curl -s --connect-timeout 10 --max-time 30 -X POST "$CALLBACK_URL/subtask/create" \
            -H "Content-Type: application/json" \
            -H "X-Callback-Signature: $CALLBACK_SECRET" \
            -d "$payload" > /dev/null 2>&1 || true
    elif [ "$action" = "update" ]; then
        payload="$payload,\"status\":\"$status\""
        if [ -n "$output_path" ]; then
            payload="$payload,\"output_path\":\"$output_path\""
        fi
        if [ -n "$error_msg" ]; then
            payload="$payload,\"error_msg\":\"$(echo "$error_msg" | sed 's/"/\\"/g')\""
        fi
        payload="$payload}"
        curl -s --connect-timeout 10 --max-time 30 -X POST "$CALLBACK_URL/subtask/update" \
            -H "Content-Type: application/json" \
            -H "X-Callback-Signature: $CALLBACK_SECRET" \
            -d "$payload" > /dev/null 2>&1 || true
    fi
}

ACQUIRE_ACCOUNT_TIMEOUT=300
ACQUIRE_ACCOUNT_INTERVAL=5

acquire_ai_account() {
    local ai_accounts="$1"
    local work_dir="$2"
    local shot_index="$3"
    local frame_type="$4"
    
    cd "$work_dir"
    
    local target_index=$(( shot_index % ACCOUNT_COUNT ))
    local max_attempts=$((ACQUIRE_ACCOUNT_TIMEOUT / ACQUIRE_ACCOUNT_INTERVAL))
    local attempts=0
    
    while [ $attempts -lt $max_attempts ]; do
        local lock_file="./locks/account_${target_index}.lock"
        
        if (set -o noclobber; echo "$$" > "$lock_file") 2>/dev/null; then
            trap "rm -f '$lock_file'" EXIT
            
            if [ -n "$ai_accounts" ]; then
                local is_bad=$(grep -c "^${target_index}$" "./bad_accounts.txt" 2>/dev/null || echo 0)
                if [ "$is_bad" -gt 0 ]; then
                    rm -f "$lock_file"
                    attempts=$((attempts + 1))
                    sleep $ACQUIRE_ACCOUNT_INTERVAL
                    continue
                fi
            fi
            
            echo "Shot $shot_index ${frame_type}: Acquired AI account index $target_index" >&2
            echo "$target_index"
            return 0
        fi
        
        attempts=$((attempts + 1))
        sleep $ACQUIRE_ACCOUNT_INTERVAL
    done
    
    echo "Shot $shot_index ${frame_type}: Failed to acquire AI account after $ACQUIRE_ACCOUNT_TIMEOUT seconds" >&2
    echo "-1"
    return 1
}

release_ai_account() {
    local work_dir="$1"
    local account_index="$2"
    
    cd "$work_dir"
    local lock_file="./locks/account_${account_index}.lock"
    rm -f "$lock_file"
    echo "Released AI account index $account_index"
}

process_frame() {
    local shot_index="$1"
    local frame_type="$2"
    local work_dir="${3:-.}"
    local ai_accounts="${4:-$AI_ACCOUNTS}"

    cd "$work_dir"

    notify_subtask "create" "$shot_index" "$frame_type" "" "" ""

    if [ -f "./ai_shot_frames/shot_${shot_index}_${frame_type}.png" ] && [ -s "./ai_shot_frames/shot_${shot_index}_${frame_type}.png" ]; then
        echo "Frame shot_${shot_index}_${frame_type} already exists, skipping"
        notify_subtask "update" "$shot_index" "$frame_type" "COMPLETED" "${TASK_ID}/ai_shot_frames/shot_${shot_index}_${frame_type}.png" ""
        echo "${shot_index}_${frame_type}:SUCCESS" >> "./frame_results.txt"
        return 0
    fi

    notify_subtask "update" "$shot_index" "$frame_type" "PROCESSING" "" ""

    DEFAULT_PROMPT="修改为美式动画风格，保留原始图片的元素和内容, 只改变风格。"
    MAIN_PROMPT="${CUSTOM_PROMPT:-${PROMPT:-$DEFAULT_PROMPT}}"
    if [ -n "$CUSTOM_PROMPT" ]; then
        echo "  Frame $FRAME_INDEX: Using custom prompt"
    fi

    FRAME_KEY="${TASK_ID}/shot_frames/shot_${shot_index}_${frame_type}.jpg"

    echo "Processing shot $shot_index, ${frame_type} frame..."

    R2_PUBLIC_URL="${R2_PUBLIC_URL:-https://aivideobucket.ygtxl.dpdns.org}"
    INPUT_IMAGE_URL="${R2_PUBLIC_URL}/${FRAME_KEY}"

    echo "  Input image URL: $INPUT_IMAGE_URL"

    local account_index=$(acquire_ai_account "$ai_accounts" "$work_dir" "$shot_index" "$frame_type")
    
    if [ "$account_index" = "-1" ]; then
        echo "Error: Failed to acquire AI account for shot $shot_index, ${frame_type} frame"
        echo "${shot_index}_${frame_type}:FAILED" >> "./frame_results.txt"
        return 1
    fi

    local selected_key="$AI_API_KEY"
    local selected_url="${AI_BASE_URL:-https://apihub.agnes-ai.com}/v1/images/generations"

    local selected_alias=""
    if [ -n "$ai_accounts" ]; then
        selected_key=$(echo "$ai_accounts" | jq -r ".[$account_index].api_key_encrypted")
        selected_url=$(echo "$ai_accounts" | jq -r ".[$account_index].base_url")
        selected_alias=$(echo "$ai_accounts" | jq -r ".[$account_index].account_alias")
        if [ "$selected_url" = "null" ] || [ -z "$selected_url" ]; then
            selected_url="https://apihub.agnes-ai.com/v1/images/generations"
        elif [[ "$selected_url" != */v1/images/generations ]]; then
            selected_url="${selected_url%/}/v1/images/generations"
        fi
    fi

    echo "Shot $shot_index ${frame_type}: Using AI account index $account_index (alias: $selected_alias)"
    echo "  Shot $shot_index ${frame_type}: API URL: $selected_url"

    MAX_RETRIES=3
    RETRY_DELAY=10
    API_SUCCESS=0
    RESPONSE=""

    BAD_ACCOUNTS_FILE="./bad_accounts.txt"

    for attempt in $(seq 1 $MAX_RETRIES); do
        echo "  Shot $shot_index ${frame_type}: Attempt $attempt/$MAX_RETRIES..."

        IMAGE_ARRAY="[\"$INPUT_IMAGE_URL\"]"

        RESPONSE=$(curl -s -X POST \
            --connect-timeout 30 \
            --max-time 120 \
            -w "\n%{http_code}" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $selected_key" \
            -d "{
                \"model\": \"agnes-image-2.1-flash\",
                \"prompt\": \"$MAIN_PROMPT\",
                \"size\": \"1024x768\",
                \"extra_body\": {
                    \"image\": $IMAGE_ARRAY,
                    \"response_format\": \"url\"
                }
            }" \
            "$selected_url")

        HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
        RESPONSE_BODY=$(echo "$RESPONSE" | sed '$d')

        echo "  Shot $shot_index ${frame_type}: HTTP_CODE=$HTTP_CODE"
        if [ -n "$RESPONSE_BODY" ] && [ "$RESPONSE_BODY" != "null" ]; then
            echo "  Shot $shot_index ${frame_type}: Response (first 200 chars): ${RESPONSE_BODY:0:200}"
        fi

        if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
            API_SUCCESS=1
            RESPONSE="$RESPONSE_BODY"
            break
        fi

        if [ "$HTTP_CODE" -eq 401 ] || [ "$HTTP_CODE" -eq 403 ]; then
            local ACCOUNT_ALIAS=$(echo "$ai_accounts" | jq -r ".[$account_index].account_alias // \"Unknown\"")
            local ACCOUNT_ID=$(echo "$ai_accounts" | jq -r ".[$account_index].id // \"\"")
            echo "  Shot $shot_index ${frame_type}: Account [$ACCOUNT_ALIAS] (index $account_index) returned $HTTP_CODE, marking as bad"
            echo "$account_index" >> "$BAD_ACCOUNTS_FILE"
            
            set +e
            curl -s --connect-timeout 10 --max-time 30 -X POST "$CALLBACK_URL/account-error" \
                -H "Content-Type: application/json" \
                -H "X-Callback-Signature: $CALLBACK_SECRET" \
                -d "{\"task_id\":\"$TASK_ID\",\"account_id\":${ACCOUNT_ID:-null},\"error_type\":\"invalid_credentials\",\"message\":\"Account returned $HTTP_CODE\"}" > /dev/null 2>&1
            set -e
            
            release_ai_account "$work_dir" "$account_index"
            echo "${shot_index}_${frame_type}:FAILED" >> "./frame_results.txt"
            return 1
        fi

        if [ "$HTTP_CODE" -eq 429 ] || [ "$HTTP_CODE" -eq 503 ]; then
            echo "  Shot $shot_index ${frame_type}: Rate limited ($HTTP_CODE), increasing delay"
            RETRY_DELAY=$((RETRY_DELAY * 2))
        fi

        if [ "$HTTP_CODE" -ge 500 ]; then
            echo "  Shot $shot_index ${frame_type}: Server error ($HTTP_CODE)"
        fi

        if [ $attempt -lt $MAX_RETRIES ]; then
            echo "  Shot $shot_index ${frame_type}: Sleeping $RETRY_DELAY seconds before retry..."
            sleep $RETRY_DELAY
        fi
    done

    release_ai_account "$work_dir" "$account_index"

    if [ $API_SUCCESS -ne 1 ]; then
        echo "Error: Failed to convert shot $shot_index, ${frame_type} frame"
        rm -f "./input_${shot_index}_${frame_type}.jpg"
        notify_subtask "update" "$shot_index" "$frame_type" "FAILED" "" "Failed to convert frame after $MAX_RETRIES attempts"
        echo "${shot_index}_${frame_type}:FAILED" >> "./frame_results.txt"
        return 1
    fi

    RESULT_URL=$(echo "$RESPONSE" | jq -r '.data[0].url // ""')
    if [ -z "$RESULT_URL" ]; then
        echo "Error: No result URL for shot $shot_index, ${frame_type} frame"
        rm -f "./input_${shot_index}_${frame_type}.jpg"
        notify_subtask "update" "$shot_index" "$frame_type" "FAILED" "" "No result URL returned"
        echo "${shot_index}_${frame_type}:FAILED" >> "./frame_results.txt"
        return 1
    fi

    OUTPUT_FILE="./ai_shot_frames/shot_${shot_index}_${frame_type}.png"
    DOWNLOAD_FILE="${OUTPUT_FILE}.download"
    rm -f "$OUTPUT_FILE" "$DOWNLOAD_FILE"

    echo "Downloading converted frame..."
    if ! curl -fsSL --connect-timeout 30 --max-time 60 -o "$DOWNLOAD_FILE" "$RESULT_URL"; then
        echo "Error: Failed to download converted frame"
        rm -f "$DOWNLOAD_FILE"
        notify_subtask "update" "$shot_index" "$frame_type" "FAILED" "" "Failed to download converted frame"
        echo "${shot_index}_${frame_type}:FAILED" >> "./frame_results.txt"
        return 1
    fi

    echo "Normalizing converted frame to PNG..."
    if ! ffmpeg -y -v error -i "$DOWNLOAD_FILE" -frames:v 1 "$OUTPUT_FILE"; then
        echo "Error: Failed to encode converted frame as PNG"
        rm -f "$DOWNLOAD_FILE" "$OUTPUT_FILE"
        notify_subtask "update" "$shot_index" "$frame_type" "FAILED" "" "Failed to encode converted frame as PNG"
        echo "${shot_index}_${frame_type}:FAILED" >> "./frame_results.txt"
        return 1
    fi
    rm -f "$DOWNLOAD_FILE"

    if [ ! -f "$OUTPUT_FILE" ] || [ ! -s "$OUTPUT_FILE" ]; then
        echo "Error: Converted PNG frame is empty"
        rm -f "./input_${shot_index}_${frame_type}.jpg"
        notify_subtask "update" "$shot_index" "$frame_type" "FAILED" "" "Converted PNG frame is empty"
        echo "${shot_index}_${frame_type}:FAILED" >> "./frame_results.txt"
        return 1
    fi

    rm -f "./input_${shot_index}_${frame_type}.jpg"
    notify_subtask "update" "$shot_index" "$frame_type" "COMPLETED" "${TASK_ID}/ai_shot_frames/shot_${shot_index}_${frame_type}.png" ""
    echo "${shot_index}_${frame_type}:SUCCESS" >> "./frame_results.txt"
    echo "Successfully converted shot $shot_index, ${frame_type} frame"

    return 0
}

export -f process_frame
export -f acquire_ai_account
export -f release_ai_account
export -f notify_subtask
export TASK_ID
export R2_BUCKET_NAME
export R2_ENDPOINT_URL
export AI_API_KEY
export AI_BASE_URL
export ACCOUNT_COUNT
export ACQUIRE_ACCOUNT_TIMEOUT
export ACQUIRE_ACCOUNT_INTERVAL
export CALLBACK_URL
export CALLBACK_SECRET

MAX_ROUNDS=3

report_progress() {
    local round=$1
    local processed=$2
    local total=$TOTAL_FRAMES
    local failed=$3
    local message="第${round}轮: 已完成 ${processed}/${total} 个帧"
    if [ "$failed" -gt 0 ]; then
        message="${message}, ${failed}个失败待重试"
    fi
    echo "Reporting progress: $message"
    set +e
    curl -s --connect-timeout 10 --max-time 30 -X POST "$CALLBACK_URL/progress" \
        -H "Content-Type: application/json" \
        -H "X-Callback-Signature: $CALLBACK_SECRET" \
        -d "{\"task_id\":\"$TASK_ID\",\"phase\":\"CONVERT_FRAMES\",\"processed_count\":$processed,\"total_count\":$total,\"failed_count\":$failed,\"message\":\"$message\"}" > /dev/null 2>&1
    set -e
}

get_missing_frames() {
    local missing=""
    for i in $(seq 0 $((SHOT_COUNT - 1))); do
        for frame_type in first last; do
            if [ ! -f "./ai_shot_frames/shot_${i}_${frame_type}.png" ] || [ ! -s "./ai_shot_frames/shot_${i}_${frame_type}.png" ]; then
                missing="${missing}${i} ${frame_type}\n"
            fi
        done
    done
    echo -e "$missing"
}

if [ -n "$SUBTASK_INDEX" ] && [ -n "$SUBTASK_TYPE" ]; then
    FRAME_TYPE="${SUBTASK_TYPE#frame_}"
    
    # 从 metadata 中解析真实的 shot_index（metadata 格式: {"shot_index":N,"frame_type":"first/last"}）
    SHOT_INDEX="$SUBTASK_INDEX"
    if [ -n "$METADATA" ]; then
        META_SHOT=$(echo "$METADATA" | jq -r '.shot_index // ""' 2>/dev/null)
        META_FRAME=$(echo "$METADATA" | jq -r '.frame_type // ""' 2>/dev/null)
        if [ -n "$META_SHOT" ] && [ "$META_SHOT" != "null" ]; then
            SHOT_INDEX="$META_SHOT"
        fi
        if [ -n "$META_FRAME" ] && [ "$META_FRAME" != "null" ]; then
            FRAME_TYPE="$META_FRAME"
        fi
    fi
    
    echo "=== Running as subtask: Shot $SHOT_INDEX, $FRAME_TYPE frame ==="
    
    rm -f "./frame_results.txt"
    rm -f "./bad_accounts.txt"
    
    process_frame "$SHOT_INDEX" "$FRAME_TYPE" "$WORK_DIR" "$AI_ACCOUNTS"
    
    echo "Uploading converted frames..."
    aws s3 sync "./ai_shot_frames" "s3://$R2_BUCKET_NAME/${TASK_ID}/ai_shot_frames" \
        --endpoint-url "$R2_ENDPOINT_URL" \
        --exclude "*" \
        --include "*.png" \
        --content-type "image/png"
    
    if [ -f "./ai_shot_frames/shot_${SHOT_INDEX}_${FRAME_TYPE}.png" ] && [ -s "./ai_shot_frames/shot_${SHOT_INDEX}_${FRAME_TYPE}.png" ]; then
        echo "Subtask completed successfully"
        exit 0
    else
        echo "Subtask failed"
        exit 1
    fi
else
    for round in $(seq 1 $MAX_ROUNDS); do
        PENDING_FRAMES=$(get_missing_frames)

        if [ -z "$(echo "$PENDING_FRAMES" | tr -d '[:space:]')" ]; then
            echo "All frames completed at round $((round - 1))"
            break
        fi

        echo "=== Round $round/$MAX_ROUNDS: Processing remaining frames ==="

        rm -f "./frame_results.txt"
        rm -f "./bad_accounts.txt"

        echo -e "$PENDING_FRAMES" | xargs -P "$EFFECTIVE_CONCURRENCY" -n 2 bash -c 'process_frame "$@"' _ || true

        echo "Uploading converted frames..."
        aws s3 sync "./ai_shot_frames" "s3://$R2_BUCKET_NAME/${TASK_ID}/ai_shot_frames" \
            --endpoint-url "$R2_ENDPOINT_URL" \
            --exclude "*" \
            --include "*.png" \
            --content-type "image/png"

        TOTAL_SUCCESS=0
        TOTAL_FAILED=0
        for i in $(seq 0 $((SHOT_COUNT - 1))); do
            for frame_type in first last; do
                if [ -f "./ai_shot_frames/shot_${i}_${frame_type}.png" ] && [ -s "./ai_shot_frames/shot_${i}_${frame_type}.png" ]; then
                    TOTAL_SUCCESS=$((TOTAL_SUCCESS + 1))
                else
                    TOTAL_FAILED=$((TOTAL_FAILED + 1))
                fi
            done
        done

    report_progress "$round" "$TOTAL_SUCCESS" "$TOTAL_FAILED"

    if [ "$TOTAL_FAILED" -eq 0 ]; then
        echo "=== All frames completed at round $round ==="
        break
    fi

    echo "Round $round: $TOTAL_FAILED frames still missing, will retry..."

    if [ "$round" -lt "$MAX_ROUNDS" ]; then
        WAIT_TIME=$((round * 15))
        echo "Waiting $WAIT_TIME seconds before next round..."
        sleep $WAIT_TIME
    fi

done

FINAL_MISSING=$(get_missing_frames)
if [ -n "$(echo "$FINAL_MISSING" | tr -d '[:space:]')" ]; then
    FINAL_FAILED_COUNT=$(echo -e "$FINAL_MISSING" | grep -c .)
    echo "ERROR: $FINAL_FAILED_COUNT frames failed after $MAX_ROUNDS rounds"
    exit 1
fi

echo "Frame conversion phase completed. All $TOTAL_FRAMES frames converted successfully."
fi
