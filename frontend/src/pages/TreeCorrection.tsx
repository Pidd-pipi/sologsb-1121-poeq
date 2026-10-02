import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  type TableProps,
} from 'antd';
import {
  CheckOutlined,
  EditOutlined,
  PlusOutlined,
  SaveOutlined,
  SplitCellsOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { usePlotStore } from '../stores/plotStore';
import { useTreeStore } from '../stores/treeStore';
import { useTreeGroupStore } from '../stores/treeGroupStore';
import RoundTag from '../components/common/RoundTag';
import { getRecheckState } from '../utils/db';
import {
  detectTreeIssues,
  effectiveTreeNo,
  correctionWarnings,
  suggestCandidates,
  type TreeGroup,
  type TreeIssue,
} from '../types/treeGroup';
import type { TreeRecord } from '../types/tree';

type Columns = NonNullable<TableProps<TreeRecord>['columns']>;

/** 下一个可用树号（最大数字树号 + 1） */
function nextTreeNo(trees: TreeRecord[], plotId: string): string {
  const nums = trees
    .filter((t) => t.plotId === plotId && /^\d+$/.test(t.treeNo.trim()))
    .map((t) => parseInt(t.treeNo.trim(), 10));
  return String((nums.length ? Math.max(...nums) : 0) + 1);
}

/** /plots/:id/correction 样木编号校正：归并/拆分/改号，整组确认后一起修改 */
export default function TreeCorrection() {
  const { id = '' } = useParams();
  const plot = usePlotStore((s) => s.items.find((p) => p.id === id));
  const trees = useTreeStore((s) => s.items);
  const groups = useTreeGroupStore((s) => s.groups);
  const loadGroups = useTreeGroupStore((s) => s.load);
  const saveDraft = useTreeGroupStore((s) => s.saveDraft);
  const removeDraft = useTreeGroupStore((s) => s.removeDraft);
  const confirmGroup = useTreeGroupStore((s) => s.confirm);

  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [recheckStale, setRecheckStale] = useState(false);

  // 校正弹窗
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [canonical, setCanonical] = useState('');
  const [note, setNote] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [modalError, setModalError] = useState('');
  const [issueContext, setIssueContext] = useState('');

  useEffect(() => {
    if (!id) return;
    void loadGroups(id);
    void getRecheckState(id).then((s) => setRecheckStale(s?.status === 'stale'));
  }, [id, loadGroups]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const plotTrees = useMemo(() => trees.filter((t) => t.plotId === id), [trees, id]);
  const issues = useMemo(() => detectTreeIssues(id, trees, groups), [id, trees, groups]);
  const blockCount = issues.filter((i) => i.severity === 'block').length;
  const warnCount = issues.filter((i) => i.severity === 'warn').length;

  const memberRecords = useMemo(
    () =>
      memberIds
        .map((mid) => plotTrees.find((t) => t.id === mid))
        .filter((t): t is TreeRecord => Boolean(t))
        .sort((a, b) => a.round - b.round || a.treeNo.localeCompare(b.treeNo, 'zh-Hans-CN', { numeric: true })),
    [memberIds, plotTrees],
  );

  const candidates = useMemo(() => {
    if (memberRecords.length === 0) return [];
    return suggestCandidates(memberRecords[0], plotTrees, new Set(memberIds));
  }, [memberRecords, plotTrees]);

  const warnings = useMemo(
    () =>
      memberIds.length > 0 && canonical.trim()
        ? correctionWarnings(plotTrees, id, memberIds, canonical, overrides)
        : [],
    [plotTrees, id, memberIds, canonical, overrides],
  );

  const openNew = (prefill?: { treeNo?: string; recordIds?: string[]; context?: string }) => {
    setEditingId(undefined);
    setCanonical(prefill?.treeNo ?? '');
    setNote('');
    setMemberIds(prefill?.recordIds ?? []);
    setOverrides({});
    setModalError('');
    setIssueContext(prefill?.context ?? '');
    setModalOpen(true);
  };

  /** 合并为同一株：把跨树号/跨期的记录并入一组 */
  const openMerge = (issue: TreeIssue) => {
    openNew({
      treeNo: issue.treeNo,
      recordIds: issue.recordIds,
      context: issue.message,
    });
  };

  /** 拆分为不同株：把后半段记录改到新树号，两株分开 */
  const openSplit = (issue: TreeIssue) => {
    const laterId = issue.recordIds[issue.recordIds.length - 1];
    const suggested = nextTreeNo(plotTrees, id);
    openNew({
      treeNo: suggested,
      recordIds: [laterId],
      context: `${issue.message}。拆分为不同株：为该记录指定新树号，确认后两株即分开。`,
    });
  };

  const openEdit = (g: TreeGroup) => {
    setEditingId(g.id);
    setCanonical(g.canonicalTreeNo);
    setNote(g.note);
    setMemberIds(g.memberTreeIds);
    setOverrides({ ...(g.treeNoOverrides ?? {}) });
    setModalError('');
    setIssueContext('');
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setModalError('');
  };

  const addMember = (recordId: string) => {
    setMemberIds((prev) => (prev.includes(recordId) ? prev : [...prev, recordId]));
    const rec = plotTrees.find((t) => t.id === recordId);
    if (rec && !canonical.trim()) setCanonical(rec.treeNo);
  };

  const removeMember = (recordId: string) => {
    setMemberIds((prev) => prev.filter((x) => x !== recordId));
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[recordId];
      return next;
    });
  };

  const setOverride = (recordId: string, value: string) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (value.trim()) next[recordId] = value.trim();
      else delete next[recordId];
      return next;
    });
  };

  const buildDraft = () => ({
    id: editingId,
    plotId: id,
    canonicalTreeNo: canonical,
    memberTreeIds: memberIds,
    treeNoOverrides: overrides,
    note,
  });

  const handleSaveDraft = async () => {
    if (!canonical.trim()) {
      setModalError('统一树号必填');
      return;
    }
    if (memberIds.length === 0) {
      setModalError('请至少选择一株样木记录');
      return;
    }
    await saveDraft(buildDraft());
    setModalOpen(false);
    setToast('校正组草稿已保存，可继续修改后整组确认');
  };

  const handleConfirm = async () => {
    if (!canonical.trim()) {
      setModalError('统一树号必填');
      return;
    }
    if (memberIds.length === 0) {
      setModalError('请至少选择一株样木记录');
      return;
    }
    const res = await confirmGroup(id, buildDraft());
    if (res.ok) {
      await useTreeStore.getState().load();
      setModalOpen(false);
      setRecheckStale(true);
      setToast('校正组已确认并生效：样木档案已整组修改，引用这些样木的复查结果已失效待重算');
    } else {
      // 事务已回滚、草稿已保留，修正后可接着做
      setModalError(`${res.error ?? '校正失败'}。原档案已恢复，草稿已保留，修正后可继续确认。`);
    }
  };

  const memberColumns: Columns = [
    {
      title: '期次',
      dataIndex: 'round',
      width: 90,
      render: (v: number) => `第 ${v} 期`,
    },
    {
      title: '树号',
      dataIndex: 'treeNo',
      width: 150,
      render: (v: string, row: TreeRecord) => {
        const ov = overrides[row.id];
        return ov ? (
          <span>
            {v} <Tag color="blue">→ {ov}</Tag>
          </span>
        ) : (
          v
        );
      },
    },
    { title: '树种', dataIndex: 'species', width: 110 },
    { title: '胸径 cm', dataIndex: 'dbhCm', width: 90 },
    { title: '树高 m', dataIndex: 'heightM', width: 90 },
    { title: '枝下高 m', dataIndex: 'underBranchH', width: 90 },
    { title: '冠幅 m', dataIndex: 'crownWidth', width: 90 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => (
        <Tag color={v === '活立木' ? 'green' : v === '采伐' ? 'red' : 'orange'}>{v}</Tag>
      ),
    },
    { title: '位置描述', dataIndex: 'remark', ellipsis: true },
    {
      title: '改号',
      width: 110,
      render: (_: unknown, row: TreeRecord) => (
        <Input
          size="small"
          placeholder="新树号"
          value={overrides[row.id] ?? ''}
          onChange={(e) => setOverride(row.id, e.target.value)}
        />
      ),
    },
    {
      title: '操作',
      width: 70,
      render: (_: unknown, row: TreeRecord) => (
        <Button size="small" type="link" danger onClick={() => removeMember(row.id)}>
          移除
        </Button>
      ),
    },
  ];

  if (!plot) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该样地（可能已被删除）" />
        <Link to="/plots">返回样地台账</Link>
      </Space>
    );
  }

  const drafts = groups.filter((g) => g.status === 'draft');
  const confirmed = groups.filter((g) => g.status === 'confirmed');

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          样木编号校正 · {plot.plotNo}
        </Typography.Title>
        <RoundTag round={plot.surveyRound} locked={plot.locked} />
        <Tag color="blue">待处理 {issues.length} 项</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/plots/${plot.id}/trees`}>样木录入</Link>
        </Button>
        <Button type="link">
          <Link to={`/plots/${plot.id}/recheck`}>复查比对</Link>
        </Button>
        <Button type="link">
          <Link to={`/summary/${plot.id}`}>林分汇总</Link>
        </Button>
        <Button type="link">
          <Link to="/plots">返回台账</Link>
        </Button>
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}
      {recheckStale ? (
        <Alert
          type="warning"
          showIcon
          message="复查结果已失效待重算"
          description="编号校正后，引用这些样木的复查结果已作废。请重新生成比对表并保存；汇总与导出暂停使用复查旧值。"
          action={
            <Button size="small" type="primary">
              <Link to={`/plots/${plot.id}/recheck`}>前往重算</Link>
            </Button>
          }
        />
      ) : null}

      <Alert
        type="info"
        showIcon
        message="校正说明"
        description="同一株被拆成两条（同株异号）→ 并入一个校正组；两株并成一条（异株同号）→ 拆出改号。合并/拆分时并排列出每期胸径、树高、位置和状态，整组确认后一起修改；跨过缺测期再出现的树号需重新确认。期内重复树号先拦住，处理失败恢复原档案并保留草稿。"
      />

      <Row gutter={12}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="期内重号（拦截）" value={blockCount} suffix="项" valueStyle={{ color: '#cf1322' }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="跨期再现 / 疑似串株" value={warnCount} suffix="项" valueStyle={{ color: '#d48806' }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="草稿组" value={drafts.length} suffix="个" />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="已生效组" value={confirmed.length} suffix="个" valueStyle={{ color: '#389e0d' }} />
          </Card>
        </Col>
      </Row>

      <Row gutter={12}>
        <Col span={11}>
          <Card
            size="small"
            title="问题清单"
            extra={
              <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openNew()}>
                新建校正组
              </Button>
            }
          >
            {issues.length === 0 ? (
              <Empty description="未发现编号问题" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {issues.map((issue) => (
                  <Card
                    key={issue.key}
                    size="small"
                    type="inner"
                    title={
                      <Space size={6}>
                        {issue.severity === 'block' ? (
                          <Tag color="red" icon={<WarningOutlined />}>
                            拦截
                          </Tag>
                        ) : (
                          <Tag color="orange" icon={<WarningOutlined />}>
                            待确认
                          </Tag>
                        )}
                        <Typography.Text strong>树号 {issue.treeNo}</Typography.Text>
                        <Tag>第 {issue.rounds.join('、')} 期</Tag>
                      </Space>
                    }
                    extra={
                      <Space size={4}>
                        {issue.type === 'duplicate' ? (
                          <Button size="small" type="primary" onClick={() => openMerge(issue)}>
                            去校正
                          </Button>
                        ) : (
                          <>
                            <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => openMerge(issue)}>
                              合并为同一株
                            </Button>
                            <Button size="small" icon={<SplitCellsOutlined />} onClick={() => openSplit(issue)}>
                              拆分为不同株
                            </Button>
                          </>
                        )}
                      </Space>
                    }
                  >
                    <Typography.Text type="secondary">{issue.message}</Typography.Text>
                  </Card>
                ))}
              </Space>
            )}
          </Card>
        </Col>

        <Col span={13}>
          <Card size="small" title="校正组">
            {groups.length === 0 ? (
              <Empty description="暂无校正组" image={Empty.PRESENTED_IMAGE_SIMPLE}>
                <Button type="primary" onClick={() => openNew()}>
                  新建校正组
                </Button>
              </Empty>
            ) : (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {groups.map((g) => {
                  const members = g.memberTreeIds
                    .map((mid) => plotTrees.find((t) => t.id === mid))
                    .filter((t): t is TreeRecord => Boolean(t));
                  const rounds = Array.from(new Set(members.map((t) => t.round))).sort((a, b) => a - b);
                  return (
                    <Card
                      key={g.id}
                      size="small"
                      type="inner"
                      title={
                        <Space size={6}>
                          {g.status === 'confirmed' ? (
                            <Tag color="green">已生效</Tag>
                          ) : (
                            <Tag color="default">草稿</Tag>
                          )}
                          <Typography.Text strong>统一树号 {g.canonicalTreeNo}</Typography.Text>
                          <Tag>{members.length} 条记录</Tag>
                          <Tag>第 {rounds.join('、')} 期</Tag>
                        </Space>
                      }
                      extra={
                        g.status === 'draft' ? (
                          <Space size={4}>
                            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(g)}>
                              继续编辑
                            </Button>
                            <Popconfirm
                              title="删除该草稿？"
                              description="删除后不可恢复，已确认生效的组不受影响。"
                              onConfirm={() => removeDraft(g.id)}
                              okText="删除"
                              cancelText="取消"
                            >
                              <Button size="small" danger>
                                删除草稿
                              </Button>
                            </Popconfirm>
                          </Space>
                        ) : (
                          <Typography.Text type="secondary">
                            {g.confirmedAt ? new Date(g.confirmedAt).toLocaleString('zh-CN') : ''}
                          </Typography.Text>
                        )
                      }
                    >
                      <Space wrap size={[4, 8]}>
                        {members.map((t) => (
                          <Tag key={t.id}>
                            第 {t.round} 期 · 树号 {effectiveTreeNo(t, g.canonicalTreeNo, g.treeNoOverrides ?? {})} ·{' '}
                            {t.species} · {t.dbhCm}cm
                          </Tag>
                        ))}
                      </Space>
                      {g.note ? (
                        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                          备注：{g.note}
                        </Typography.Paragraph>
                      ) : null}
                    </Card>
                  );
                })}
              </Space>
            )}
          </Card>
        </Col>
      </Row>

      <Modal
        title={editingId ? '编辑校正组草稿' : '新建校正组'}
        open={modalOpen}
        onCancel={closeModal}
        width={1080}
        footer={
          <Space>
            <Button onClick={closeModal}>取消</Button>
            <Button icon={<SaveOutlined />} onClick={handleSaveDraft}>
              保存草稿
            </Button>
            <Button type="primary" icon={<CheckOutlined />} onClick={handleConfirm}>
              整组确认并修改
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={10} style={{ width: '100%', marginTop: 8 }}>
          {modalError ? <Alert type="error" showIcon message={modalError} /> : null}
          {issueContext ? <Alert type="warning" showIcon message={issueContext} /> : null}
          {warnings.length > 0 ? (
            <Alert
              type="info"
              showIcon
              message={
                <Space direction="vertical" size={2}>
                  {warnings.map((w) => (
                    <span key={w}>{w}</span>
                  ))}
                </Space>
              }
            />
          ) : null}
          <Space wrap size={10}>
            <span>
              统一树号
              <Input
                style={{ width: 140, marginLeft: 6 }}
                placeholder="校正后树号"
                value={canonical}
                onChange={(e) => setCanonical(e.target.value)}
              />
            </span>
            <span>
              加入样木
              <Select
                key={memberIds.length}
                style={{ width: 360, marginLeft: 6 }}
                placeholder="按期次/树号/树种选择同株记录"
                value={undefined}
                onChange={(v: string) => addMember(v)}
                options={plotTrees
                  .filter((t) => !memberIds.includes(t.id))
                  .map((t) => ({
                    value: t.id,
                    label: `第 ${t.round} 期 · 树号 ${t.treeNo} · ${t.species} · 胸径 ${t.dbhCm}cm · ${t.remark || '无位置'}`,
                  }))}
                showSearch
                filterOption={(input, option) => String(option?.label ?? '').includes(input)}
              />
            </span>
            <Input
              style={{ width: 260 }}
              placeholder="备注（可选）"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Space>

          {candidates.length > 0 ? (
            <Card size="small" title="疑似同株候选（同树种、生长连续、位置相近）">
              <Space wrap size={8}>
                {candidates.map((c) => (
                  <Tag
                    key={c.record.id}
                    color="blue"
                    style={{ cursor: 'pointer' }}
                    onClick={() => addMember(c.record.id)}
                  >
                    第 {c.record.round} 期 · 树号 {c.record.treeNo} · {c.record.dbhCm}cm（{c.reason}） ＋
                  </Tag>
                ))}
              </Space>
            </Card>
          ) : null}

          <Typography.Text type="secondary">
            并排列出各期胸径、树高、位置和状态；同一株的各期记录都应在组内，不同株请拆出并改号。
          </Typography.Text>

          <Table<TreeRecord>
            rowKey="id"
            size="small"
            columns={memberColumns}
            dataSource={memberRecords}
            pagination={false}
            scroll={{ x: 1100 }}
            locale={{ emptyText: '尚未选择样木记录' }}
          />
        </Space>
      </Modal>
    </Space>
  );
}
