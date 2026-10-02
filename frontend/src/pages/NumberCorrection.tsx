import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  Input,
  Popconfirm,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  type TableProps,
} from 'antd';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  RollbackOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import { usePlotStore } from '../stores/plotStore';
import { useTreeStore } from '../stores/treeStore';
import RoundTag from '../components/common/RoundTag';
import {
  editOfRecord,
  emptyDraft,
  gapConfirmKey,
  evaluateCorrection,
  type CorrectionDraftData,
  type CorrectionGroup,
  type CorrectionIssue,
  type RecordAction,
} from '../types/correction';
import {
  clearCorrectionDraft,
  commitCorrection,
  CorrectionBlockedError,
  loadCorrectionDraft,
  loadResolvedGapKeys,
  persistConfirmedGaps,
  saveCorrectionDraft,
} from '../utils/correctionStore';
import type { TreeRecord } from '../types/tree';

const STATUS_COLOR: Record<string, string> = {
  活立木: 'green',
  枯立木: 'orange',
  倒木: 'gold',
  采伐: 'red',
};

function issueTag(issue: CorrectionIssue) {
  const color = issue.level === 'error' ? 'red' : 'orange';
  return (
    <Tooltip key={issue.kind + (issue.round ?? '') + issue.message} title={issue.message}>
      <Tag color={color} style={{ marginBottom: 4 }}>
        {issue.level === 'error' ? <ExclamationCircleOutlined /> : <CheckCircleOutlined />}{' '}
        {issue.kind === 'gap-reappear'
          ? `跨缺测期重现·${issue.targetNo}`
          : issue.kind === 'source-duplicate'
            ? `第 ${issue.round} 期期内重复`
            : issue.kind === 'target-duplicate'
              ? `第 ${issue.round} 期改号后重复·${issue.targetNo}`
              : issue.kind === 'empty-target'
                ? '树号为空'
                : issue.kind === 'species-mismatch'
                  ? `树种不一致·${issue.targetNo}`
                  : issue.kind === 'location-mismatch'
                    ? `位置不一致·${issue.targetNo}`
                    : `胸径回退·${issue.targetNo}`}
      </Tag>
    </Tooltip>
  );
}

/** /plots/:id/correction 样木编号校正：并排各期胸径/树高/位置/状态，整组确认后原子提交 */
export default function NumberCorrection() {
  const { id = '' } = useParams();
  const plot = usePlotStore((s) => s.items.find((p) => p.id === id));
  const allTrees = useTreeStore((s) => s.items);
  const reloadTrees = useTreeStore((s) => s.reload);

  const plotTrees = useMemo(
    () =>
      allTrees
        .filter((t) => t.plotId === id)
        .sort((a, b) => a.round - b.round || a.treeNo.localeCompare(b.treeNo, 'zh-Hans-CN', { numeric: true })),
    [allTrees, id],
  );

  const [draft, setDraft] = useState<CorrectionDraftData>(() => emptyDraft());
  const [resolvedGaps, setResolvedGaps] = useState<Set<string>>(new Set());
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft(loadCorrectionDraft(id));
    setResolvedGaps(loadResolvedGapKeys(id));
    setDraftLoaded(true);
    setError('');
    setToast('');
  }, [id]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const evaluation = useMemo(
    () => evaluateCorrection(plotTrees, draft, resolvedGaps),
    [plotTrees, draft, resolvedGaps],
  );

  const hasDraftEdits =
    Object.keys(draft.edits).length > 0 || Object.keys(draft.gapConfirmed).length > 0;

  const persistDraft = (next: CorrectionDraftData) => {
    setDraft(next);
    saveCorrectionDraft(id, next);
  };

  const setRecordTarget = (rec: TreeRecord, raw: string) => {
    const prev = editOfRecord(rec, draft);
    persistDraft({
      ...draft,
      edits: { ...draft.edits, [rec.id]: { ...prev, targetNo: raw } },
    });
  };

  const setRecordAction = (rec: TreeRecord, action: RecordAction) => {
    const prev = editOfRecord(rec, draft);
    persistDraft({ ...draft, edits: { ...draft.edits, [rec.id]: { ...prev, action } } });
  };

  const setGroupTarget = (group: CorrectionGroup, targetNo: string) => {
    const edits = { ...draft.edits };
    group.records.forEach((rec) => {
      const prev = editOfRecord(rec, draft);
      if (prev.action !== 'void') edits[rec.id] = { ...prev, targetNo };
    });
    persistDraft({ ...draft, edits });
  };

  const toggleGapConfirm = (sourceNo: string, targetNo: string, checked: boolean) => {
    const key = gapConfirmKey(sourceNo, targetNo);
    persistDraft({
      ...draft,
      gapConfirmed: { ...draft.gapConfirmed, [key]: checked },
    });
  };

  const resetAll = () => {
    const empty = emptyDraft();
    clearCorrectionDraft(id);
    setDraft(empty);
    setError('');
    setToast('已放弃全部修改并恢复原始树号');
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await commitCorrection(id, draft);
      // 固化缺测重现确认（按校正后树号），再与档案库对齐
      persistConfirmedGaps(id, plotTrees, draft);
      setResolvedGaps(loadResolvedGapKeys(id));
      await reloadTrees();
      clearCorrectionDraft(id);
      setDraft(emptyDraft());
      setToast(
        `编号校正已写入档案：改号 ${result.updated} 条、作废 ${result.voided} 条；` +
          `${result.invalidated} 条复查比对已失效待重算，请回复查页重新生成`,
      );
    } catch (e) {
      // 事务失败时 Dexie 已回滚原档案；草稿保留，修正后可接着提交
      const message = e instanceof CorrectionBlockedError ? e.message : '写入失败，档案已恢复原样，草稿保留';
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  if (!plot) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该样地" />
        <Link to="/plots">返回样地台账</Link>
      </Space>
    );
  }

  const blocked =
    evaluation.hardErrorCount > 0 || evaluation.gapPendingCount > 0 || evaluation.changeCount === 0;

  const roundColumns: NonNullable<TableProps<CorrectionGroup>['columns']> = evaluation.rounds.map(
    (round) => ({
      title: `第 ${round} 期`,
      width: 250,
      render: (_: unknown, group: CorrectionGroup) => {
        const recs = group.records.filter(
          (r) => r.round === round && editOfRecord(r, draft).action !== 'void',
        );
        if (recs.length === 0) {
          const anyRecs = group.records.filter((r) => r.round === round);
          return anyRecs.length > 0 ? <Tag>本期记录已作废</Tag> : <Tag>本期无记录（缺测）</Tag>;
        }
        return (
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {recs.map((rec) => {
              const edit = editOfRecord(rec, draft);
              const voided = edit.action === 'void';
              const renamed = edit.targetNo.trim() !== rec.treeNo;
              return (
                <Card
                  key={rec.id}
                  size="small"
                  style={{
                    background: voided ? '#fafafa' : recs.length > 1 ? '#fff2f0' : '#f6ffed',
                    borderColor: recs.length > 1 ? '#ffccc7' : undefined,
                    opacity: voided ? 0.55 : 1,
                  }}
                  styles={{ body: { padding: 8 } }}
                >
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                    <Space size={4} wrap>
                      <Typography.Text strong>{rec.species}</Typography.Text>
                      <Tag color={STATUS_COLOR[rec.status] ?? 'default'}>{rec.status}</Tag>
                      {recs.length > 1 && <Tag color="red">期内重复 {recs.length} 条</Tag>}
                      {renamed && <Tag color="blue">原 {rec.treeNo} 号</Tag>}
                    </Space>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      胸径 {rec.dbhCm} cm ｜ 树高 {rec.heightM} m
                      <br />
                      位置：{rec.remark || '—'}
                    </Typography.Text>
                    <Space size={6} wrap>
                      <span style={{ fontSize: 12 }}>
                        划归树号
                        <Input
                          size="small"
                          style={{ width: 72, marginLeft: 4 }}
                          value={edit.targetNo}
                          disabled={voided}
                          status={!edit.targetNo.trim() ? 'error' : undefined}
                          onChange={(e) => setRecordTarget(rec, e.target.value)}
                        />
                      </span>
                      <Popconfirm
                        title={voided ? '恢复该条记录？' : '作废该条记录？'}
                        description={
                          voided
                            ? '恢复后参与编号校正'
                            : '作废（重复/误录）后提交时从档案删除，不可再参与复查比对'
                        }
                        onConfirm={() => setRecordAction(rec, voided ? 'keep' : 'void')}
                      >
                        <Button size="small" danger={!voided} type={voided ? 'link' : 'default'}>
                          {voided ? '恢复' : '作废'}
                        </Button>
                      </Popconfirm>
                    </Space>
                  </Space>
                </Card>
              );
            })}
          </Space>
        );
      },
    }),
  );

  const columns: NonNullable<TableProps<CorrectionGroup>['columns']> = [
    {
      title: '原始树号',
      dataIndex: 'sourceNo',
      width: 110,
      render: (no: string, group) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{no} 号</Typography.Text>
          {group.duplicateRounds.length > 0 && (
            <Badge status="error" text={`第 ${group.duplicateRounds.join('、')} 期重复`} />
          )}
        </Space>
      ),
    },
    ...roundColumns,
    {
      title: '株线与确认',
      width: 260,
      render: (_: unknown, group: CorrectionGroup) => (
        <Space direction="vertical" size={6}>
          {group.chains.length === 0 && <Tag color="red">全部记录已作废</Tag>}
          {group.chains.map((chain) => (
            <Space key={chain.targetNo || '__empty'} direction="vertical" size={2}>
              <Space size={4}>
                <Tag color="blue">{chain.targetNo || '(空)'} 号株线</Tag>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  第 {chain.records.map((r) => r.round).join('、')} 期
                </Typography.Text>
              </Space>
              {chain.hasGap && (
                <Checkbox
                  checked={chain.gapConfirmed}
                  onChange={(e) => toggleGapConfirm(group.sourceNo, chain.targetNo, e.target.checked)}
                >
                  <Typography.Text type={chain.gapConfirmed ? 'success' : 'danger'} style={{ fontSize: 12 }}>
                    已核对现场号牌，{chain.targetNo} 号跨缺测期为同一株
                  </Typography.Text>
                </Checkbox>
              )}
            </Space>
          ))}
          <Input
            size="small"
            allowClear
            style={{ width: 180 }}
            placeholder="整组改号（拆分勿用）"
            onChange={(e) => setGroupTarget(group, e.target.value)}
          />
        </Space>
      ),
    },
    {
      title: '审计疑点',
      width: 260,
      render: (_: unknown, group: CorrectionGroup) =>
        group.issues.length === 0 ? (
          <Tag color="green">无异常</Tag>
        ) : (
          <Space size={4} wrap>
            {group.issues.map(issueTag)}
          </Space>
        ),
    },
  ];

  const expandedRowRender = (group: CorrectionGroup) => (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      {group.issues.map((issue) => (
        <Alert
          key={issue.kind + (issue.round ?? '') + issue.message}
          type={issue.level === 'error' ? 'error' : 'warning'}
          showIcon
          style={{ padding: '2px 10px' }}
          message={issue.message}
        />
      ))}
    </Space>
  );

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          样木编号校正 · {plot.plotNo}
        </Typography.Title>
        <RoundTag round={plot.surveyRound} locked={plot.locked} />
        <Tag>{plot.forestType}</Tag>
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
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}

      <Alert
        type="info"
        showIcon
        message="校正规则"
        description="各期胸径/树高/位置/状态按原始树号并排列出。同一株被拆成两条：把记录划归同一树号合并；两株并成一条：把错配期记录划归另一树号拆分；重复或误录条直接作废。跨缺测期再出现的树号须核对现场号牌后逐条确认。整组确认后一次性提交；期内重复树号未处理前一律拦住，复查结果会同步失效并待重算。"
      />

      {hasDraftEdits && (
        <Alert
          type="warning"
          showIcon
          message="存在未提交草稿（仅保存在本机浏览器），提交失败或关闭页面后仍可接着修改"
        />
      )}

      <Row gutter={12}>
        <Col span={4}>
          <Card size="small">
            <Statistic title="原始树号组" value={evaluation.groups.length} suffix="组" />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="待改号" value={evaluation.renameCount} suffix="条" />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="待作废" value={evaluation.voidCount} suffix="条" />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic
              title="硬拦截 / 待确认"
              value={evaluation.hardErrorCount + evaluation.gapPendingCount}
              suffix={`条（疑点 ${evaluation.warningCount}）`}
              valueStyle={{
                color: evaluation.hardErrorCount + evaluation.gapPendingCount > 0 ? '#cf1322' : '#3f8600',
              }}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small">
            <Space>
              <Popconfirm
                title="放弃当前全部校正并恢复原树号？"
                onConfirm={resetAll}
                disabled={!hasDraftEdits}
              >
                <Button icon={<RollbackOutlined />} disabled={!hasDraftEdits || busy}>
                  放弃修改
                </Button>
              </Popconfirm>
              <Tooltip
                title={
                  evaluation.hardErrorCount > 0
                    ? `还有 ${evaluation.hardErrorCount} 处硬拦截（期内重复/改号冲突）`
                    : evaluation.gapPendingCount > 0
                      ? `还有 ${evaluation.gapPendingCount} 个跨缺测期树号未确认`
                      : evaluation.changeCount === 0
                        ? '没有任何改动'
                        : '整组确认并写入档案，相关复查结果将立即失效待重算'
                }
              >
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  loading={busy}
                  disabled={!draftLoaded || blocked}
                  onClick={submit}
                >
                  整组确认并提交
                </Button>
              </Tooltip>
            </Space>
          </Card>
        </Col>
      </Row>

      <Card size="small" title={`并排校正表（覆盖第 ${evaluation.rounds.join('、') || '—'} 期）`}>
        {plotTrees.length === 0 ? (
          <Empty description="该样地暂无样木记录" />
        ) : (
          <Table<CorrectionGroup>
            rowKey="sourceNo"
            size="small"
            columns={columns}
            dataSource={evaluation.groups}
            pagination={false}
            scroll={{ x: 'max-content' }}
            expandable={{
              expandedRowRender,
              rowExpandable: (group) => group.issues.length > 0,
              defaultExpandedRowKeys: evaluation.groups
                .filter((g) => g.issues.some((i) => i.level === 'error'))
                .map((g) => g.sourceNo),
            }}
            rowClassName={(group) =>
              group.issues.some((i) => i.level === 'error') ? 'correction-row-error' : ''
            }
          />
        )}
      </Card>
    </Space>
  );
}
