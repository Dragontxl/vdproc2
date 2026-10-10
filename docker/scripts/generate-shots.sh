#!/bin/bash

set -e

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

echo "=== Phase 5: Shot Generation ==="
echo "Task ID: $TASK_ID"
echo "AI Account ID: $AI_ACCOUNT_ID"
echo "Output FPS: $OUTPUT_FPS"

WORK_DIR="/tmp/$TASK_ID"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

LOG_FILE="/tmp/generate-shots.log"
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

echo "Found $SHOT_COUNT shots to generate"

mkdir -p ./generated_shots

echo "Syncing existing generated shots from R2 (reuse across retries/cancellations)..."
aws s3 sync "s3://$R2_BUCKET_NAME/${TASK_ID}/generated_shots" "./generated_shots" \
    --endpoint-url "$R2_ENDPOINT_URL" || true
REUSE_EXISTING_SHOTS=${REUSE_EXISTING_SHOTS:-true}
echo "REUSE_EXISTING_SHOTS=$REUSE_EXISTING_SHOTS"

echo "DEBUG: AI_ACCOUNTS raw value: ${AI_ACCOUNTS:0:200}"
echo "DEBUG: AI_ACCOUNTS length: ${#AI_ACCOUNTS}"

ACCOUNT_COUNT=0
if [ -n "$AI_ACCOUNTS" ]; then
    echo "DEBUG: AI_ACCOUNTS before filter: $AI_ACCOUNTS"
    AI_ACCOUNTS=$(echo "$AI_ACCOUNTS" | jq -c '[.[] | select(.api_type == "video")]')
    ACCOUNT_COUNT=$(echo "$AI_ACCOUNTS" | jq -r '. | length')
    echo "DEBUG: AI_ACCOUNTS after filter: $AI_ACCOUNTS"
    echo "DEBUG: ACCOUNT_COUNT after filter: $ACCOUNT_COUNT"
fi

if [ "$ACCOUNT_COUNT" -eq 0 ]; then
    echo "Error: No video-type AI accounts available"
    echo "DEBUG: AI_API_KEY length: ${#AI_API_KEY}"
    echo "DEBUG: AI_BASE_URL: $AI_BASE_URL"
    exit 1
fi

MAX_CONCURRENT=${MAX_CONCURRENT:-2}
EFFECTIVE_CONCURRENCY=$(( ACCOUNT_COUNT < MAX_CONCURRENT ? ACCOUNT_COUNT : MAX_CONCURRENT ))

echo "Available AI accounts: $ACCOUNT_COUNT"
echo "Max concurrent (from GitHub accounts): $MAX_CONCURRENT"
echo "Effective concurrency: $EFFECTIVE_CONCURRENCY"

notify_subtask() {
    local action="$1"
    local shot_index="$2"
    local status="$3"
    local output_path="$4"
    local error_msg="$5"
    
    if [ -z "$CALLBACK_URL" ]; then
        return
    fi
    
    local r2_public_url="${R2_PUBLIC_URL:-https://aivideobucket.ygtxl.dpdns.org}"
    local first_frame_url="${r2_public_url}/${TASK_ID}/ai_shot_frames/shot_${shot_index}_first.png"
    if [ "$shot_index" -gt 0 ]; then
        first_frame_url="${r2_public_url}/${TASK_ID}/ai_shot_frames/shot_$((shot_index - 1))_last.png"
    fi
    local last_frame_url="${r2_public_url}/${TASK_ID}/ai_shot_frames/shot_${shot_index}_last.png"
    
    local payload="{\"task_id\":\"$TASK_ID\",\"phase\":\"GENERATE_SHOTS\",\"subtask_index\":$shot_index"
    
    if [ "$action" = "create" ]; then
        payload="$payload,\"subtask_type\":\"shot\",\"input_path\":\"$first_frame_url|$last_frame_url\",\"metadata\":\"{\\\"shot_index\\\":$shot_index}\"}"
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

export -f notify_subtask

MAX_ROUNDS=3
if [ -n "$SUBTASK_INDEX" ]; then
    MAX_ROUNDS=1
fi
PENDING_FILE="/tmp/pending_indices.txt"
MISSING_FILE="/tmp/missing_indices.txt"

if [ -n "$SUBTASK_INDEX" ]; then
    echo "Running as subtask: Shot index $SUBTASK_INDEX"
    echo "$SUBTASK_INDEX" > "$PENDING_FILE"
else
    seq -s, 0 $((SHOT_COUNT - 1)) > "$PENDING_FILE"
fi

report_progress() {
    local round=$1
    local processed=$2
    local total=$SHOT_COUNT
    local failed=$3
    local message="第${round}轮: 已完成 ${processed}/${total} 个分镜"
    if [ "$failed" -gt 0 ]; then
        message="${message}, ${failed}个失败待重试"
    fi
    echo "Reporting progress: $message"
    set +e
    curl -s --connect-timeout 10 --max-time 30 -X POST "$CALLBACK_URL/progress" \
        -H "Content-Type: application/json" \
        -H "X-Callback-Signature: $CALLBACK_SECRET" \
        -d "{\"task_id\":\"$TASK_ID\",\"phase\":\"GENERATE_SHOTS\",\"processed_count\":$processed,\"total_count\":$total,\"failed_count\":$failed,\"message\":\"$message\"}" > /dev/null 2>&1
    set -e
}

for round in $(seq 1 $MAX_ROUNDS); do
    PENDING_INDICES=$(cat "$PENDING_FILE")
    if [ -z "$PENDING_INDICES" ]; then
        echo "All shots completed at round $((round - 1))"
        break
    fi

    echo "=== Round $round/$MAX_ROUNDS: Processing shots [$PENDING_INDICES] ==="

    export PENDING_INDICES
    export EFFECTIVE_CONCURRENCY

    python3 << PYTHON_SCRIPT
import json
import os
import sys
import time
import urllib.request
import urllib.error
import ssl
import threading
import random
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse, quote

ssl._create_default_https_context = ssl._create_unverified_context

task_id = os.environ.get('TASK_ID')
ai_accounts_json = os.environ.get('AI_ACCOUNTS', '').strip() or '[]'
pending_indices_str = os.environ.get('PENDING_INDICES', '')

with open('./analysis_result.json', 'r') as f:
    result = json.load(f)

storyboards = result.get('storyboards', [])
accounts = json.loads(ai_accounts_json)

video_accounts = [acc for acc in accounts if acc.get('api_type', 'video') == 'video']
if video_accounts:
    accounts = video_accounts
    print(f"  Filtered to {len(accounts)} video-type AI accounts")

if pending_indices_str:
    pending_indices = [int(x) for x in pending_indices_str.split(',') if x.strip()]
else:
    pending_indices = list(range(len(storyboards)))

def parse_time(time_str):
    parts = time_str.split(':')
    h = int(parts[0])
    m = int(parts[1])
    s_parts = parts[2].split('.')
    s = int(s_parts[0])
    ms = int(s_parts[1]) if len(s_parts) > 1 else 0
    return h * 3600 + m * 60 + s + ms / 1000

bad_accounts = set()
bad_accounts_lock = threading.Lock()

if accounts:
    account_locks = [threading.Lock() for _ in range(len(accounts))]
else:
    account_locks = [threading.Lock()]
last_create_ts = [0.0] * len(account_locks)
CREATE_MIN_INTERVAL = float(os.environ.get('ACCOUNT_CREATE_INTERVAL', '60'))
SERVER_BACKOFF_BASE = float(os.environ.get('SERVER_BACKOFF_BASE', '30'))
SERVER_BACKOFF_MAX = float(os.environ.get('SERVER_BACKOFF_MAX', '300'))

def generate_video(accounts_list, start_index, image_urls, prompt, shot_index, duration_seconds, output_fps):
    custom_prompt = os.environ.get('CUSTOM_PROMPT', '').strip()
    if custom_prompt:
        full_prompt = custom_prompt
        print(f"  Shot {shot_index}: Using custom prompt")
    else:
        full_prompt = prompt

    # Agnes Video 2.0：按 num_frames + frame_rate 生成，keyframes 模式用 extra_body.image 传图
    target_frames = int(duration_seconds * output_fps)
    if target_frames < 9:
        num_frames = 9
    else:
        n = (target_frames - 1) // 8
        num_frames = n * 8 + 1
        if num_frames < 9:
            num_frames = 9

    video_width = int(os.environ.get('VIDEO_WIDTH', '832'))
    video_height = int(os.environ.get('VIDEO_HEIGHT', '448'))

    request_body = {
        'model': 'agnes-video-v2.0',
        'prompt': full_prompt,
        'mode': 'keyframes',
        'num_frames': num_frames,
        'frame_rate': output_fps,
        'width': video_width,
        'height': video_height,
        'extra_body': {
            'image': image_urls,
            'mode': 'keyframes'
        }
    }

    print(f"  Shot {shot_index}: Duration: {duration_seconds:.3f}s, FPS: {output_fps}, Target frames: {num_frames}")
    print(f"  Shot {shot_index}: Request body num_frames: {num_frames}, frame_rate: {output_fps}, expected duration: {num_frames/output_fps:.2f}s")
    print(f"  Shot {shot_index}: Prompt length: {len(full_prompt)} characters")
    print(f"  Shot {shot_index}: Prompt preview (first 500 chars): {full_prompt[:500]}...")
    print(f"  Shot {shot_index}: Request body keys: {list(request_body.keys())}")
    print(f"  Shot {shot_index}: extra_body keys: {list(request_body.get('extra_body', {}).keys())}")
    print(f"  Shot {shot_index}: Image URLs count: {len(request_body.get('extra_body', {}).get('image', []))}")

    max_retries = 3
    retry_delay = 10

    candidates = []
    if accounts_list:
        for offset in range(len(accounts_list)):
            idx = (start_index + offset) % len(accounts_list)
            with bad_accounts_lock:
                if idx not in bad_accounts:
                    candidates.append(idx)
    if not candidates:
        for offset in range(len(accounts_list) if accounts_list else 1):
            candidates.append(offset)

    for cand_idx in candidates:
        lock = account_locks[cand_idx] if cand_idx < len(account_locks) else account_locks[0]
        with lock:
            if accounts_list:
                account = accounts_list[cand_idx]
                api_key = account.get('api_key_encrypted', '').strip()
                base_url = account.get('base_url', '').strip()
                model_override = os.environ.get('VIDEO_MODEL', '').strip()
                model_name = (model_override or account.get('model_name') or 'agnes-video-v2.0').strip()
                account_alias = account.get('account_alias', '')
                
                if not base_url:
                    base_url = 'https://apihub.agnes-ai.com/v1/videos'
                elif '/v1/videos' not in base_url:
                    parsed = urlparse(base_url)
                    base_url = f"{parsed.scheme}://{parsed.netloc}/v1/videos"
                
                print(f"  Shot {shot_index}: Using AI account index {cand_idx} (alias: {account_alias})")
            else:
                print(f"  Shot {shot_index}: Error: No AI accounts available")
                return None

            if not base_url.startswith('http'):
                base_url = 'https://' + base_url

            request_body['model'] = model_name
            json_data = json.dumps(request_body, ensure_ascii=False).encode('utf-8')

            headers = {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + api_key
            }

            db_account_id = account.get('id') if accounts_list else 'default'
            print(f"  Shot {shot_index}: Using AI account index {cand_idx} (db_id={db_account_id}, model={model_name}, URL={base_url})")

            task_id_result = None
            video_id_result = None
            auth_failed = False

            for attempt in range(max_retries):
                try:
                    print(f"  Shot {shot_index}: Attempt {attempt+1}/{max_retries} - URL: {base_url}")
                    if accounts_list:
                        # 按账号限速：距该账号上一次 create 不足 ACCOUNT_CREATE_INTERVAL 秒则等待
                        elapsed = time.time() - last_create_ts[cand_idx]
                        if elapsed < CREATE_MIN_INTERVAL:
                            wait = CREATE_MIN_INTERVAL - elapsed
                            print(f"  Shot {shot_index}: account idx {cand_idx} 限速冷却中，等待 {wait:.0f}s")
                            time.sleep(wait)
                        last_create_ts[cand_idx] = time.time()
                    req = urllib.request.Request(base_url, data=json_data, headers=headers, method='POST')
                    resp = urllib.request.urlopen(req, timeout=300)
                    resp_body = resp.read().decode('utf-8')
                    resp_data = json.loads(resp_body)

                    print(f"  Shot {shot_index}: Attempt {attempt+1}/{max_retries} - HTTP 200")
                    print(f"  Shot {shot_index}: Response: {resp_body[:500]}...")

                    task_id_result = resp_data.get('task_id') or resp_data.get('id') or resp_data.get('taskId')
                    video_id_result = resp_data.get('video_id')

                    if task_id_result:
                        print(f"  Shot {shot_index}: Got task ID: {task_id_result}")
                        if video_id_result:
                            print(f"  Shot {shot_index}: Got video ID: {video_id_result}")
                        break

                except urllib.error.HTTPError as e:
                    err_msg = f"HTTP Error {e.code}: {e.reason}"
                    print(f"  Shot {shot_index}: Attempt {attempt+1}/{max_retries} failed: {err_msg}")
                    if e.code == 401:
                        auth_failed = True
                        break
                    if e.code == 429:
                        # 限流，指数退避
                        backoff = 30 * (attempt + 1)
                        print(f"  Shot {shot_index}: 429 rate limited, waiting {backoff}s before retry...")
                        time.sleep(backoff)
                    elif 500 <= e.code < 600:
                        # 上游过载（503/502/504 等）：更长指数退避 + 抖动，减少无效打点
                        backoff = min(SERVER_BACKOFF_MAX, SERVER_BACKOFF_BASE * (2 ** attempt)) + random.uniform(0, 15)
                        print(f"  Shot {shot_index}: server error {e.code}, waiting {backoff:.0f}s before retry...")
                        time.sleep(backoff)
                    elif attempt < max_retries - 1:
                        time.sleep(retry_delay)
                except Exception as e:
                    print(f"  Shot {shot_index}: Attempt {attempt+1}/{max_retries} failed: {str(e)}")
                    if attempt < max_retries - 1:
                        time.sleep(retry_delay)

            if auth_failed:
                account_alias = accounts[cand_idx].get('account_alias', 'Unknown')
                print(f"  Shot {shot_index}: Account [{account_alias}] (index {cand_idx}, db_id={db_account_id}) returned 401, marking as bad - please check this account")
                with bad_accounts_lock:
                    bad_accounts.add(cand_idx)
                
                import subprocess
                callback_url = os.environ.get('CALLBACK_URL', '')
                callback_secret = os.environ.get('CALLBACK_SECRET', '')
                task_id_env = os.environ.get('TASK_ID', '')
                if callback_url and task_id_env:
                    try:
                        subprocess.run([
                            'curl', '-s', '--connect-timeout', '10', '--max-time', '30',
                            '-X', 'POST', f"{callback_url}/account-error",
                            '-H', 'Content-Type: application/json',
                            '-H', f"X-Callback-Signature: {callback_secret}",
                            '-d', f'{{"task_id":"{task_id_env}","account_id":{db_account_id},"error_type":"invalid_credentials","message":"Account returned 401"}}'
                        ], check=False, capture_output=True)
                    except Exception as e:
                        print(f"  Shot {shot_index}: Failed to send account error callback: {str(e)}")
                
                continue

            if not task_id_result:
                print(f"  Shot {shot_index}: Failed to get task ID with account {cand_idx}, trying next account")
                continue

            print(f"  Shot {shot_index}: Polling for result...")
            max_polls = 90
            poll_interval = 10

            query_id = video_id_result if video_id_result else task_id_result

            # 根据官方文档，轮询URL格式: {domain}/agnesapi?video_id={video_id}
            parsed_base = urlparse(base_url)
            poll_base = f"{parsed_base.scheme}://{parsed_base.netloc}"

            for poll_attempt in range(max_polls):
                time.sleep(poll_interval)
                try:
                    poll_url = f"{poll_base}/agnesapi?video_id={quote(query_id)}"
                    req = urllib.request.Request(poll_url, headers={'Authorization': 'Bearer ' + api_key}, method='GET')
                    resp = urllib.request.urlopen(req, timeout=30)
                    resp_body = resp.read().decode('utf-8')
                    resp_data = json.loads(resp_body)

                    status = resp_data.get('status', '')
                    progress = resp_data.get('progress', 0)
                    print(f"  Shot {shot_index}: Poll {poll_attempt+1}/{max_polls} - Status: {status}, Progress: {progress}%")

                    if status == 'completed':
                        print(f"  Shot {shot_index}: Completed response: {resp_body[:2000]}")
                        url = resp_data.get('url') or resp_data.get('remixed_from_video_id')
                        if not url:
                            metadata = resp_data.get('metadata', {})
                            url = metadata.get('url') if isinstance(metadata, dict) else None
                        if url:
                            print(f"  Shot {shot_index}: Got video URL: {url}")
                            return url
                        print(f"  Shot {shot_index}: Task completed but no URL found")
                        return None
                    elif status in ['failed', 'error']:
                        error_msg = resp_data.get('error', 'Unknown error')
                        print(f"  Shot {shot_index}: Task failed: {error_msg}")
                        return None

                except Exception as e:
                    print(f"  Shot {shot_index}: Poll {poll_attempt+1} failed: {str(e)}")

            print(f"  Shot {shot_index}: Polling timeout")
            return None

    print(f"  Shot {shot_index}: All accounts exhausted")
    return None

def notify_subtask_python(action, shot_index, status='', output_path='', error_msg=''):
    import subprocess
    callback_url = os.environ.get('CALLBACK_URL', '')
    callback_secret = os.environ.get('CALLBACK_SECRET', '')
    task_id_env = os.environ.get('TASK_ID', '')
    
    if not callback_url:
        return
    
    cmd = ['bash', '-c', f'notify_subtask "{action}" "{shot_index}" "{status}" "{output_path}" "{error_msg}"']
    try:
        subprocess.run(cmd, check=False, capture_output=True)
    except Exception as e:
        print(f"  Shot {shot_index}: Failed to notify subtask: {str(e)}")

def upload_to_r2(local_path, shot_index):
    import subprocess
    bucket = os.environ.get('R2_BUCKET_NAME', '')
    endpoint = os.environ.get('R2_ENDPOINT_URL', '')
    if not bucket or not endpoint:
        print(f"  Shot {shot_index}: Error: R2_BUCKET_NAME/R2_ENDPOINT_URL not set")
        return False

    key = f"s3://{bucket}/{task_id}/generated_shots/shot_{shot_index}.mp4"
    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        try:
            result = subprocess.run(
                ['aws', 's3', 'cp', local_path, key, '--endpoint-url', endpoint],
                capture_output=True, text=True
            )
            if result.returncode == 0:
                print(f"  Shot {shot_index}: Uploaded to R2: {key}")
                return True
            print(f"  Shot {shot_index}: R2 upload attempt {attempt}/{max_attempts} failed: {result.stderr.strip()}")
        except Exception as e:
            print(f"  Shot {shot_index}: R2 upload attempt {attempt}/{max_attempts} error: {str(e)}")
        if attempt < max_attempts:
            time.sleep(5)
    return False

def process_shot(shot_index):
    shot = storyboards[shot_index]
    start_time = shot.get('start_time', '00:00:00.000')
    end_time = shot.get('end_time', '00:00:00.000')
    start_sec = parse_time(start_time)
    end_sec = parse_time(end_time)
    duration = end_sec - start_sec

    print(f"Processing shot {shot_index}: {start_time} - {end_time} (duration={duration:.3f}s)")
    notify_subtask_python("create", shot_index)

    import time
    callback_url = os.environ.get('CALLBACK_URL', 'https://ai-video.ldragon.xyz/api/v1/callback')
    api_base = callback_url.replace('/api/v1/callback', '') if '/api/v1/callback' in callback_url else callback_url
    cache_buster = int(time.time())
    first_frame_url = f"{api_base}/api/v1/files/preview/shot_{shot_index}_first.png?prefix={task_id}/ai_shot_frames/&no_cache=true&t={cache_buster}"
    last_frame_url = f"{api_base}/api/v1/files/preview/shot_{shot_index}_last.png?prefix={task_id}/ai_shot_frames/&no_cache=true&t={cache_buster}"

    print(f"First frame URL: {first_frame_url}")
    print(f"Last frame URL: {last_frame_url}")

    characters_present = shot.get('characters_present', [])
    dialogues = shot.get('dialogues', [])
    scene_desc = shot.get('scene_description', '')
    camera_movement = shot.get('camera_movement', '')

    video_summary = result.get('video_summary', '')

    global_characters = result.get('characters', [])
    char_map = {c.get('role_id'): c for c in global_characters}

    first_keyframe_chars = shot.get('first_keyframe_characters', [])
    last_keyframe_chars = shot.get('last_keyframe_characters', [])
    
    first_positions = {c.get('role_id'): (c.get('x', 0.5), c.get('y', 0.3)) for c in first_keyframe_chars}
    last_positions = {c.get('role_id'): (c.get('x', 0.5), c.get('y', 0.3)) for c in last_keyframe_chars}

    # 角色描述以"关键帧实测可见角色"为准：模型只看得到首尾帧，描述画面里不存在的人
    # 会导致它凭空生成多余人物，或把台词安到不该出现的人身上。
    measured_roles = set()
    for kc in first_keyframe_chars + last_keyframe_chars:
        r = kc.get('role_id')
        if r:
            measured_roles.add(r)
    measured_any = bool(first_keyframe_chars or last_keyframe_chars)
    description_roles = []
    if measured_any:
        for role_id in characters_present:
            if role_id in measured_roles:
                description_roles.append(role_id)
        for role_id in sorted(measured_roles):
            if role_id not in description_roles:
                description_roles.append(role_id)
    else:
        description_roles = list(characters_present)

    character_descriptions = []
    for role_id in description_roles:
        char = char_map.get(role_id)
        if char:
            char_name = char.get('name', '')
            if char_name:
                label = char_name
                voice = (char.get('voice_timbre') or '').strip()
                if voice:
                    label = f"{char_name}（音色：{voice}）"
                if role_id in first_positions:
                    x, y = first_positions[role_id]
                    x_desc = "左侧" if x < 0.3 else ("右侧" if x > 0.7 else "中央")
                    y_desc = "上方" if y < 0.3 else ("下方" if y > 0.7 else "中间")
                    character_descriptions.append(f"{label}位于首帧画面{x_desc}{y_desc}")
                elif role_id in last_positions:
                    x, y = last_positions[role_id]
                    x_desc = "左侧" if x < 0.3 else ("右侧" if x > 0.7 else "中央")
                    y_desc = "上方" if y < 0.3 else ("下方" if y > 0.7 else "中间")
                    character_descriptions.append(f"{label}位于尾帧画面{x_desc}{y_desc}")
                else:
                    character_descriptions.append(label)
            else:
                character_descriptions.append(role_id)
        else:
            character_descriptions.append(role_id)

    subtitles_part = ""
    if dialogues and isinstance(dialogues, list):
        dialogue_parts = []

        visible_roles = set()
        for kc in (shot.get('first_keyframe_characters') or []) + (shot.get('last_keyframe_characters') or []):
            r = kc.get('role_id')
            if r:
                visible_roles.add(r)
        measured_any = bool(shot.get('first_keyframe_characters') or shot.get('last_keyframe_characters'))
        present_roles = set(shot.get('characters_present') or [])
        print(f"  Shot {shot_index}: 画外音判定[present={sorted(present_roles)}, visible={sorted(visible_roles)}, measured={measured_any}]")

        for d in dialogues:
            speaker = d.get('speaker', '')
            text = d.get('text', '')
            if not text or text == 'null':
                continue

            role_id = speaker if speaker in char_map else None
            if role_id is None and speaker and speaker != 'NARRATOR' and speaker != 'null':
                for c in char_map.values():
                    if c.get('name') == speaker:
                        role_id = c.get('role_id')
                        break

            speaker_name = speaker
            if role_id and char_map.get(role_id) and char_map[role_id].get('name'):
                speaker_name = char_map[role_id]['name']

            is_narrator = speaker == 'NARRATOR' or role_id == 'NARRATOR'
            off_screen = False
            reason = ''
            if is_narrator:
                off_screen = True
                reason = '旁白'
            elif role_id and role_id != 'NARRATOR':
                if measured_any and role_id in present_roles and role_id not in visible_roles:
                    # A 在说话但镜头给到 B：说话人不在关键帧画面内 → 画外音
                    off_screen = True
                    reason = '在场但不在关键帧画面内'
                elif role_id not in present_roles:
                    off_screen = True
                    reason = '不在本镜在场角色列表'
            print(f"    {speaker_name}: {'画外音' if off_screen else '画面内'}{'（' + reason + '）' if reason else ''}")

            if off_screen:
                line = f"{speaker_name}（画外音）：{text}"
            else:
                line = f"{speaker_name}：{text}"

            if d.get('continues_from_prev'):
                line = "（承接上一分镜，本句在片段开始时已在进行中）" + line
            if d.get('continues_next'):
                line = line + "（本句持续到片段结束仍未说完）"
            dialogue_parts.append(line)

        if dialogue_parts:
            subtitles_part = "；".join(dialogue_parts)

    main_prompt = f"""场景背景：{video_summary}，本片段是其中的一个分镜。
角色描述：{'；'.join(character_descriptions)}
镜头运动：固定机位。从首帧到尾帧的机位、拍摄角度、焦距、景别与构图必须完全保持一致，只允许人物自身的动作、表情和口型在两帧之间自然过渡，绝对禁止任何推拉摇移、镜头缩放、镜头旋转、镜头平移或拍摄距离变化。
场景描述：{scene_desc}
人物对话：{subtitles_part}
关键帧要求：第1张图片为起始帧，第2张图片为结束帧；画面中只允许出现这两帧内已经存在的人物、物体和背景，绝对不要自行生成两帧之外多余的人物、物体或背景元素，也不要改变景别；背景与人物外观必须与首尾帧保持一致，只实现首帧到尾帧之间的平滑过渡。
字幕要求：不要显示任何字幕，如果关键帧含有字幕，在生成片段时要去掉字幕。
语言要求：人物对话必须严格按照提供的对话文本生成，包括文本内容、语种。如果对话文本是中文，则使用中文对话；如果对话文本是英文，则使用英文对话。人物必须与对话文本精确匹配，人物的口型必须与对话内容精确匹配。
画外音要求：对话中标注为「（画外音）」的台词由画面外的角色说出，必须使用该角色本人的音色与语调，画面内出现的任何角色都绝对不得对其对口型，只能保持倾听或表情反应。
说话人标注要求：人物对话里每个「说话人：台词」中冒号前面的部分是说话人标注，绝对不能朗读出来，只能朗读冒号后面的台词文本。
对话要求：当人物对话为空时不要生成任何对话，也不要有对话的口型。"""

    print(f"=== Shot {shot_index} Full Prompt ===")
    print(main_prompt)
    print(f"=== End Shot {shot_index} Prompt ===")

    account_index = shot_index % len(accounts) if accounts else 0
    output_fps = int(os.environ.get('OUTPUT_FPS', 24))

    print(f"Shot {shot_index}: Starting with AI account index {account_index}")
    print(f"Shot {shot_index}: Duration: {duration:.3f}s, Target frames: {int(duration * output_fps)}")

    notify_subtask_python("update", shot_index, "PROCESSING")

    existing_file = f'./generated_shots/shot_{shot_index}.mp4'
    reuse_existing = os.environ.get('REUSE_EXISTING_SHOTS', 'true').lower() != 'false'
    if reuse_existing and os.path.exists(existing_file) and os.path.getsize(existing_file) > 0:
        output_path = f"{task_id}/generated_shots/shot_{shot_index}.mp4"
        if upload_to_r2(existing_file, shot_index):
            print(f"Shot {shot_index}: Reusing existing generated video (already in R2), skipping regeneration")
            notify_subtask_python("update", shot_index, "COMPLETED", output_path)
            return (shot_index, True)

    video_url = generate_video(accounts if accounts else None, account_index, [first_frame_url, last_frame_url], main_prompt, shot_index, duration, output_fps)

    if video_url:
        print(f"Downloading generated video for shot {shot_index}...")
        local_path = f'./generated_shots/shot_{shot_index}.mp4'
        try:
            urllib.request.urlretrieve(video_url, local_path)
        except Exception as e:
            print(f"Error downloading video for shot {shot_index}: {str(e)}")
            notify_subtask_python("update", shot_index, "FAILED", "", str(e))
            return (shot_index, False)

        output_path = f"{task_id}/generated_shots/shot_{shot_index}.mp4"
        if not upload_to_r2(local_path, shot_index):
            print(f"Error: Failed to upload shot {shot_index} to R2")
            notify_subtask_python("update", shot_index, "FAILED", "", "Failed to upload to R2")
            return (shot_index, False)

        print(f"Successfully generated shot {shot_index}")
        notify_subtask_python("update", shot_index, "COMPLETED", output_path)
        return (shot_index, True)
    else:
        print(f"Error: Failed to generate shot {shot_index}")
        notify_subtask_python("update", shot_index, "FAILED", "", "Failed to generate video")
        return (shot_index, False)

effective_concurrency = int(os.environ.get('EFFECTIVE_CONCURRENCY', '2'))
max_workers = min(len(accounts) if accounts else 1, effective_concurrency)
print(f"Starting concurrent shot generation with {max_workers} workers (effective concurrency: {effective_concurrency}, AI accounts: {len(accounts) if accounts else 1})...")

round_success = 0
round_failed = 0

with ThreadPoolExecutor(max_workers=max_workers) as executor:
    futures = {executor.submit(process_shot, idx): idx for idx in pending_indices}
    
    for future in as_completed(futures):
        shot_index, success = future.result()
        if success:
            round_success += 1
        else:
            round_failed += 1

missing = []
subtask_index_str = os.environ.get('SUBTASK_INDEX', '')
if subtask_index_str:
    check_indices = [int(subtask_index_str)]
else:
    check_indices = list(range(len(storyboards)))
for i in check_indices:
    filepath = f'./generated_shots/shot_{i}.mp4'
    if not (os.path.exists(filepath) and os.path.getsize(filepath) > 0):
        missing.append(str(i))

with open('/tmp/missing_indices.txt', 'w') as f:
    f.write(','.join(missing))

print(f"=== Round Complete ===")
print(f"Round success: {round_success}")
print(f"Round failed: {round_failed}")
print(f"Still missing: {','.join(missing) if missing else 'none'}")

PYTHON_SCRIPT

    echo "Uploading generated shots..."
    aws s3 sync "./generated_shots" "s3://$R2_BUCKET_NAME/${TASK_ID}/generated_shots" \
        --endpoint-url "$R2_ENDPOINT_URL"

    MISSING_INDICES=$(cat "$MISSING_FILE")

    COMPLETED=$((SHOT_COUNT - $(echo "$MISSING_INDICES" | tr -cd ',' | wc -c) - $([ -z "$MISSING_INDICES" ] && echo 0 || echo 1)))
    if [ -z "$MISSING_INDICES" ]; then
        COMPLETED=$SHOT_COUNT
        FAILED_COUNT=0
    else
        MISSING_COUNT=$(echo "$MISSING_INDICES" | tr ',' '\n' | grep -c .)
        COMPLETED=$((SHOT_COUNT - MISSING_COUNT))
        FAILED_COUNT=$MISSING_COUNT
    fi

    report_progress "$round" "$COMPLETED" "$FAILED_COUNT"

    if [ -z "$MISSING_INDICES" ]; then
        echo "=== All shots completed at round $round ==="
        break
    fi

    echo "Round $round: $FAILED_COUNT shots still missing, will retry..."
    echo "$MISSING_INDICES" > "$PENDING_FILE"

done

FINAL_MISSING=$(cat "$MISSING_FILE" 2>/dev/null || echo "")
if [ -n "$SUBTASK_INDEX" ]; then
    SUBTASK_FILE="./generated_shots/shot_${SUBTASK_INDEX}.mp4"
    if [ -f "$SUBTASK_FILE" ] && [ -s "$SUBTASK_FILE" ]; then
        echo "Shot generation subtask completed successfully. Shot ${SUBTASK_INDEX} generated."
    else
        echo "ERROR: Shot ${SUBTASK_INDEX} generation failed"
        exit 1
    fi
else
    if [ -n "$FINAL_MISSING" ]; then
        MISSING_COUNT=$(echo "$FINAL_MISSING" | tr ',' '\n' | grep -c .)
        echo "ERROR: $MISSING_COUNT shots failed after $MAX_ROUNDS rounds: [$FINAL_MISSING]"
        echo "Shots that could not be generated: $FINAL_MISSING"
        exit 1
    fi
    echo "Shot generation phase completed. All $SHOT_COUNT shots generated successfully."
fi
