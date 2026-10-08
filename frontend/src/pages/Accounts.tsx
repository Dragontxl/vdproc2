import { useState, useEffect } from 'react';
import { Card, Table, Tag, Button, Modal, Form, Input, InputNumber, Switch, Space, message, Tabs, Select, Popconfirm } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined, HeartOutlined, LinkOutlined, SwapOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { accountApi } from '../api';
import dayjs from 'dayjs';
import 'dayjs/plugin/utc';

const dayjsUtc = (time: string) => dayjs.utc(time).local();

const { TabPane } = Tabs;

export default function Accounts() {
  const [githubAccounts, setGithubAccounts] = useState([]);
  const [aiAccounts, setAiAccounts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [currentAccount, setCurrentAccount] = useState<any>(null);
  const [accountType, setAccountType] = useState<'github' | 'ai'>('github');
  const [form] = Form.useForm();
  
  const [bindingModalOpen, setBindingModalOpen] = useState(false);
  const [currentGithubId, setCurrentGithubId] = useState<number | null>(null);
  const [bindings, setBindings] = useState([]);
  const [unboundAIAccounts, setUnboundAIAccounts] = useState([]);
  const [editBindingModalOpen, setEditBindingModalOpen] = useState(false);
  const [currentBinding, setCurrentBinding] = useState<any>(null);
  const [bindingForm] = Form.useForm();

  const loadAccounts = async () => {
    setLoading(true);
    try {
      const [ghResult, aiResult] = await Promise.all([
        accountApi.listGitHub(),
        accountApi.listAI(),
      ]);
      setGithubAccounts(ghResult.data || []);
      setAiAccounts(aiResult.data || []);
    } catch (error) {
      message.error('加载账户失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAccounts();
  }, []);

  const handleAdd = () => {
    setEditMode(false);
    setCurrentAccount(null);
    form.resetFields();
    setIsModalOpen(true);
  };

  const handleEdit = (account: any, type: 'github' | 'ai') => {
    setEditMode(true);
    setCurrentAccount(account);
    setAccountType(type);
    form.setFieldsValue(account);
    setIsModalOpen(true);
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      console.log('Saving account with values:', values);

      if (editMode) {
        if (accountType === 'github') {
          await accountApi.updateGitHub(currentAccount.id, values);
        } else {
          await accountApi.updateAI(currentAccount.id, values);
        }
        message.success('账户更新成功');
      } else {
        if (accountType === 'github') {
          await accountApi.createGitHub(values);
        } else {
          await accountApi.createAI(values);
        }
        message.success('账户创建成功');
      }

      setIsModalOpen(false);
      loadAccounts();
    } catch (error: any) {
      console.error('Save account error:', error);
      const errorMsg = error?.response?.data?.msg || error?.message || '保存账户失败';
      message.error(`保存账户失败: ${errorMsg}`);
    }
  };

  const handleDelete = async (id: number, type: 'github' | 'ai') => {
    try {
      if (type === 'github') {
        await accountApi.deleteGitHub(id);
      } else {
        await accountApi.deleteAI(id);
      }
      message.success('账户删除成功');
      loadAccounts();
    } catch (error) {
      message.error('删除账户失败');
    }
  };

  const handleHealthCheck = async (id: number) => {
    try {
      await accountApi.checkAIHealth(id);
      message.success('健康检查完成');
      loadAccounts();
    } catch (error) {
      message.error('健康检查失败');
    }
  };

  const openBindingModal = async (githubId: number) => {
    setCurrentGithubId(githubId);
    setLoading(true);
    try {
      const [bindingResult, unboundResult] = await Promise.all([
        accountApi.getBindings(githubId),
        accountApi.getUnboundAI(),
      ]);
      setBindings(bindingResult.data || []);
      setUnboundAIAccounts(unboundResult.data || []);
    } catch (error) {
      message.error('加载绑定信息失败');
    } finally {
      setLoading(false);
      setBindingModalOpen(true);
    }
  };

  const handleAddBinding = async () => {
    if (!currentGithubId) return;
    setLoading(true);
    try {
      const [unboundResult] = await Promise.all([
        accountApi.getUnboundAI(),
      ]);
      const unbound = unboundResult.data || [];
      if (unbound.length === 0) {
        message.warning('没有未绑定的AI账户可用');
        return;
      }
      const firstUnbound = unbound[0];
      await accountApi.createBinding(currentGithubId, {
        ai_account_id: firstUnbound.id,
        priority: bindings.length,
      });
      message.success('绑定成功');
      await openBindingModal(currentGithubId);
    } catch (error: any) {
      message.error(error?.response?.data?.msg || '绑定失败');
    } finally {
      setLoading(false);
    }
  };

  const handleReplaceBinding = async (bindingId: number) => {
    if (!currentGithubId) return;
    setLoading(true);
    try {
      const unboundResult = await accountApi.getUnboundAI();
      const unbound = unboundResult.data || [];
      if (unbound.length === 0) {
        message.warning('没有未绑定的AI账户可用');
        return;
      }
      const firstUnbound = unbound[0];
      await accountApi.replaceBinding(bindingId, {
        new_ai_account_id: firstUnbound.id,
      });
      message.success('更换成功');
      await openBindingModal(currentGithubId);
    } catch (error: any) {
      message.error(error?.response?.data?.msg || '更换失败');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteBinding = async (bindingId: number) => {
    if (!currentGithubId) return;
    setLoading(true);
    try {
      await accountApi.deleteBinding(bindingId);
      message.success('解绑成功');
      await openBindingModal(currentGithubId);
    } catch (error) {
      message.error('解绑失败');
    } finally {
      setLoading(false);
    }
  };

  const handleEditBinding = async (binding: any) => {
    setCurrentBinding(binding);
    // 加载所有 AI 账户（包括已绑定的，因为编辑时可以看到当前选中的）
    try {
      const result = await accountApi.listAI();
      const allAIAccounts = result.data || [];
      // 可用的 AI 账户 = 未绑定的 + 当前绑定的那个
      const currentAIAccount = allAIAccounts.find((a: any) => a.id === binding.ai_account_id);
      const availableAccounts: any[] = [...unboundAIAccounts];
      if (currentAIAccount && !availableAccounts.find((a: any) => a.id === currentAIAccount.id)) {
        availableAccounts.push(currentAIAccount);
      }
      // 按 id 排序
      availableAccounts.sort((a: any, b: any) => a.id - b.id);
      
      bindingForm.setFieldsValue({
        ai_account_id: binding.ai_account_id,
        priority: binding.priority,
      });
      // 存储可用列表到 state 或直接用
      (window as any)._editBindingAvailableAccounts = availableAccounts;
      setEditBindingModalOpen(true);
    } catch (error) {
      message.error('加载 AI 账户失败');
    }
  };

  const handleSaveBinding = async () => {
    if (!currentBinding) return;
    try {
      const values = await bindingForm.validateFields();
      await accountApi.updateBinding(currentBinding.id, {
        ai_account_id: values.ai_account_id,
        priority: values.priority,
      });
      message.success('绑定更新成功');
      setEditBindingModalOpen(false);
      if (currentGithubId) {
        await openBindingModal(currentGithubId);
      }
    } catch (error: any) {
      message.error(error?.response?.data?.msg || '更新失败');
    }
  };

  const githubColumns = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: '用户名',
      dataIndex: 'username',
      key: 'username',
    },
    {
      title: '月使用/限制',
      key: 'usage',
      render: (_: any, record: any) => `${record.monthly_used_minutes || 0}/${record.monthly_limit || 0} 分钟`,
    },
    {
      title: '状态',
      dataIndex: 'is_active',
      key: 'is_active',
      render: (active: boolean) => <Tag color={active ? 'success' : 'default'}>{active ? '活跃' : '禁用'}</Tag>,
    },
    {
      title: '是否受限',
      dataIndex: 'is_limited',
      key: 'is_limited',
      render: (limited: boolean) => <Tag color={limited ? 'error' : 'success'}>{limited ? '受限' : '正常'}</Tag>,
    },
    {
      title: '成功率',
      dataIndex: 'success_rate',
      key: 'success_rate',
      render: (rate: number) => `${rate}%`,
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (time: string) => dayjsUtc(time).format('MM-DD'),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: any) => (
        <Space>
          <Button size="small" icon={<LinkOutlined />} onClick={() => openBindingModal(record.id)}>绑定</Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(record, 'github')} />
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record.id, 'github')} />
        </Space>
      ),
    },
  ];

  const aiColumns = [
    {
      title: '别名',
      dataIndex: 'account_alias',
      key: 'account_alias',
    },
    {
      title: '类型',
      dataIndex: 'api_type',
      key: 'api_type',
      render: (type: string) => <Tag color={type === 'text' ? 'blue' : type === 'image' ? 'green' : 'purple'}>
        {type === 'text' ? '文本' : type === 'image' ? '图像' : '视频'}
      </Tag>,
    },
    {
      title: '模型',
      dataIndex: 'model_name',
      key: 'model_name',
    },
    {
      title: '日使用/限制',
      key: 'usage',
      render: (_: any, record: any) => `${record.daily_usage || 0}/${record.daily_limit || 0} 次`,
    },
    {
      title: '优先级',
      dataIndex: 'priority_weight',
      key: 'priority_weight',
    },
    {
      title: '状态',
      dataIndex: 'is_active',
      key: 'is_active',
      render: (active: boolean) => <Tag color={active ? 'success' : 'default'}>{active ? '活跃' : '禁用'}</Tag>,
    },
    {
      title: '健康状态',
      dataIndex: 'is_healthy',
      key: 'is_healthy',
      render: (healthy: boolean) => <Tag color={healthy ? 'success' : 'error'}>{healthy ? '健康' : '异常'}</Tag>,
    },
    {
      title: '成功率',
      dataIndex: 'success_rate',
      key: 'success_rate',
      render: (rate: number) => `${rate}%`,
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (time: string) => dayjsUtc(time).format('MM-DD'),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: any) => (
        <Space>
          <Button size="small" icon={<HeartOutlined />} onClick={() => handleHealthCheck(record.id)} />
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(record, 'ai')} />
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record.id, 'ai')} />
        </Space>
      ),
    },
  ];

  const bindingColumns = [
    {
      title: 'AI账户别名',
      dataIndex: 'account_alias',
      key: 'account_alias',
    },
    {
      title: '类型',
      dataIndex: 'api_type',
      key: 'api_type',
      render: (type: string) => <Tag color={type === 'text' ? 'blue' : type === 'image' ? 'green' : 'purple'}>
        {type === 'text' ? '文本' : type === 'image' ? '图像' : '视频'}
      </Tag>,
    },
    {
      title: '健康状态',
      dataIndex: 'is_healthy',
      key: 'is_healthy',
      render: (healthy: boolean) => <Tag color={healthy ? 'success' : 'error'}>{healthy ? '健康' : '异常'}</Tag>,
    },
    {
      title: '日使用/限制',
      key: 'usage',
      render: (_: any, record: any) => `${record.daily_usage || 0}/${record.daily_limit || 0} 次`,
    },
    {
      title: '优先级',
      dataIndex: 'priority',
      key: 'priority',
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: any) => (
        <Space>
          <Button 
            size="small" 
            icon={<EditOutlined />} 
            onClick={() => handleEditBinding(record)}
          >
            编辑
          </Button>
          <Button 
            size="small" 
            icon={<SwapOutlined />} 
            onClick={() => handleReplaceBinding(record.id)} 
            disabled={record.is_healthy}
            title={record.is_healthy ? '健康账户无需更换' : '更换为新账户'}
          >
            {record.is_healthy ? '正常' : '更换'}
          </Button>
          <Popconfirm
            title="确定要解绑此账户吗？"
            onConfirm={() => handleDeleteBinding(record.id)}
            okText="确定"
            cancelText="取消"
          >
            <Button size="small" danger icon={<CloseCircleOutlined />}>解绑</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 24 }}>
        <h2>账户管理</h2>
      </div>

      <Tabs defaultActiveKey="github">
        <TabPane tab="GitHub 账户" key="github">
          <Card>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setAccountType('github'); handleAdd(); }} style={{ marginBottom: 16 }}>
              添加 GitHub 账户
            </Button>
            <Table
              dataSource={githubAccounts}
              columns={githubColumns}
              loading={loading}
              rowKey="id"
              pagination={{ pageSize: 10 }}
            />
          </Card>
        </TabPane>
        <TabPane tab="AI 账户" key="ai">
          <Card>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setAccountType('ai'); handleAdd(); }} style={{ marginBottom: 16 }}>
              添加 AI 账户
            </Button>
            <Table
              dataSource={aiAccounts}
              columns={aiColumns}
              loading={loading}
              rowKey="id"
              pagination={{ pageSize: 10 }}
            />
          </Card>
        </TabPane>
      </Tabs>

      <Modal
        title={editMode ? `${accountType === 'github' ? '编辑 GitHub' : '编辑 AI'} 账户` : `${accountType === 'github' ? '添加 GitHub' : '添加 AI'} 账户`}
        open={isModalOpen}
        onOk={handleSave}
        onCancel={() => setIsModalOpen(false)}
      >
        <Form form={form} layout="vertical">
          {accountType === 'github' ? (
            <>
              <Form.Item name="name" label="账户名称" rules={[{ required: true }]}>
                <Input placeholder="请输入账户名称" />
              </Form.Item>
              <Form.Item name="username" label="GitHub 用户名">
                <Input placeholder="请输入 GitHub 用户名" />
              </Form.Item>
              <Form.Item name="token_encrypted" label="API Token（加密）" rules={[{ required: true }]}>
                <Input.Password placeholder="请输入加密后的 API Token" />
              </Form.Item>
              <Form.Item name="monthly_limit" label="月度限额（分钟）" initialValue={2000}>
                <InputNumber min={0} />
              </Form.Item>
              <Form.Item name="is_active" label="是否活跃" initialValue={true}>
                <Switch />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item name="account_alias" label="账户别名" rules={[{ required: true }]}>
                <Input placeholder="请输入账户别名" />
              </Form.Item>
              <Form.Item name="api_type" label="API 类型" rules={[{ required: true }]} initialValue="image">
                <Select>
                  <Select.Option value="text">文本模型（如 Gemini）</Select.Option>
                  <Select.Option value="image">图像模型（如图生图）</Select.Option>
                  <Select.Option value="video">视频模型（如视频生成）</Select.Option>
                </Select>
              </Form.Item>
              <Form.Item name="api_key_encrypted" label="API Key（加密）" rules={[{ required: true }]}>
                <Input.Password placeholder="请输入加密后的 API Key" />
              </Form.Item>
              <Form.Item name="base_url" label="API 地址">
                <Input placeholder="请输入 API 地址" />
              </Form.Item>
              <Form.Item name="model_name" label="模型名称">
                <Input placeholder="请输入模型名称" />
              </Form.Item>
              <Form.Item name="priority_weight" label="优先级权重" initialValue={50}>
                <InputNumber min={0} max={100} />
              </Form.Item>
              <Form.Item name="max_concurrent" label="最大并发数" initialValue={1}>
                <InputNumber min={1} />
              </Form.Item>
              <Form.Item name="daily_limit" label="日限额" initialValue={1000}>
                <InputNumber min={0} />
              </Form.Item>
              <Form.Item name="is_active" label="是否活跃" initialValue={true}>
                <Switch />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>

      <Modal
        title="绑定管理"
        open={bindingModalOpen}
        onCancel={() => setBindingModalOpen(false)}
        footer={null}
        width={800}
      >
        <div style={{ marginBottom: 16 }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAddBinding} disabled={unboundAIAccounts.length === 0}>
            添加绑定
          </Button>
          {unboundAIAccounts.length === 0 && (
            <span style={{ marginLeft: 12, color: '#999' }}>没有可用的未绑定AI账户</span>
          )}
        </div>
        <Table
          dataSource={bindings}
          columns={bindingColumns}
          loading={loading}
          rowKey="id"
          pagination={false}
          locale={{ emptyText: '暂无绑定关系' }}
        />
      </Modal>

      <Modal
        title="编辑绑定"
        open={editBindingModalOpen}
        onOk={handleSaveBinding}
        onCancel={() => setEditBindingModalOpen(false)}
        okText="保存"
        cancelText="取消"
        width={500}
      >
        <Form form={bindingForm} layout="vertical">
          <Form.Item name="ai_account_id" label="AI 账户" rules={[{ required: true, message: '请选择 AI 账户' }]}>
            <Select placeholder="请选择 AI 账户">
              {((window as any)._editBindingAvailableAccounts || []).map((acc: any) => (
                <Select.Option key={acc.id} value={acc.id}>
                  {acc.account_alias} ({acc.api_type === 'text' ? '文本' : acc.api_type === 'image' ? '图像' : '视频'})
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="priority" label="优先级" rules={[{ required: true, message: '请输入优先级' }]} initialValue={0}>
            <InputNumber min={0} style={{ width: '100%' }} placeholder="数字越小优先级越高" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}