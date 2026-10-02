import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Card, Col, Row, Select, Space, Statistic, Tag, Typography } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { usePlotStore } from '../stores/plotStore';
import { useTreeStore } from '../stores/treeStore';
import GrowthDiffTable from '../components/common/GrowthDiffTable';
import RoundTag from '../components/common/RoundTag';
import {
  loadRecheckDiffs,
  loadStaleRechecks,
  replaceRecheckDiffs,
} from '../utils/db';
import { newId } from '../utils/id';
import { growthRate, isDiffAbnormal, type RecheckDiff } from '../types/recheck';
import type { TreeRecord } from '../types/tree';

function r2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** /plots/:id/recheck 复查比对：逐株显示两期胸径/树高与生长量，标记缺失与状态变化 */
export default function RecheckView() {
  const { id = '' } = useParams();
  const plot = usePlotStore((s) => s.items.find((p) => p.id === id));
  const trees = useTreeStore((s) => s.items);

  const rounds = useMemo(
    () => Array.from(new Set(trees.filter((t) => t.plotId === id).map((t) => t.round))).sort((a, b) => a - b),
    [trees, id],
  );

  const [baseRound, setBaseRound] = useState<number>(rounds[0] ?? 1);
  const [targetRound, setTargetRound] = useState<number>(rounds[rounds.length - 1] ?? 2);
  const [diffs, setDiffs] = useState<RecheckDiff[]>([]);
  const [staleCount, setStaleCount] = useState(0);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (rounds.length >= 2) {
      setBaseRound(rounds[rounds.length - 2]);
      setTargetRound(rounds[rounds.length - 1]);
    }
  }, [rounds.join(',')]);

  useEffect(() => {
    if (!id) return;
    void Promise.all([loadRecheckDiffs(id), loadStaleRechecks(id)]).then(([rows, staleRows]) => {
      if (rows.length > 0) setDiffs(rows);
      setStaleCount(staleRows.length);
    });
  }, [id]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /** 期内重复树号硬拦截：硬配会把两株并成一条，生长量跨株 */
  const duplicateNosInRound = (round: number): string[] => {
    const counter = new Map<string, number>();
    trees
      .filter((t) => t.plotId === id && t.round === round)
      .forEach((t) => counter.set(t.treeNo, (counter.get(t.treeNo) ?? 0) + 1));
    return Array.from(counter.entries())
      .filter(([, n]) => n > 1)
      .map(([no]) => no)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));
  };

  const roundBlocked = (round: number): boolean => duplicateNosInRound(round).length > 0;

  const generate = () => {
    if (baseRound === targetRound) {
      setError('上期与本期不能是同一期次');
      return;
    }
    const dupBase = duplicateNosInRound(baseRound);
    const dupTarget = duplicateNosInRound(targetRound);
    if (dupBase.length > 0 || dupTarget.length > 0) {
      const parts: string[] = [];
      if (dupBase.length > 0) parts.push(`第 ${baseRound} 期树号 ${dupBase.join('、')}`);
      if (dupTarget.length > 0) parts.push(`第 ${targetRound} 期树号 ${dupTarget.join('、')}`);
      setError(`${parts.join('；')} 在期内重复，复查硬配已拦截，请先到编号校正页拆分或作废后再比对`);
      return;
    }
    const baseList = trees.filter((t) => t.plotId === id && t.round === baseRound);
    const targetList = trees.filter((t) => t.plotId === id && t.round === targetRound);
    const baseMap = new Map<string, TreeRecord>();
    baseList.forEach((t) => baseMap.set(t.treeNo, t));
    const targetMap = new Map<string, TreeRecord>();
    targetList.forEach((t) => targetMap.set(t.treeNo, t));
    const allNos = Array.from(new Set([...baseMap.keys(), ...targetMap.keys()])).sort((a, b) =>
      a.localeCompare(b, 'zh-Hans-CN', { numeric: true }),
    );

    const next: RecheckDiff[] = allNos.map((treeNo) => {
      const b = baseMap.get(treeNo);
      const t = targetMap.get(treeNo);
      const baseDbh = b?.dbhCm;
      const targetDbh = t?.dbhCm;
      const dbhGrowth =
        baseDbh !== undefined && targetDbh !== undefined ? r2(targetDbh - baseDbh) : 0;
      const heightGrowth =
        b && t ? r2(t.heightM - b.heightM) : 0;
      const statusChange = b && t && b.status !== t.status ? `${b.status} → ${t.status}` : '';
      const missingReason = !t ? '本期未复测（疑似采伐或倒伏）' : !b ? '本期新增进界木' : '';
      return {
        id: newId('diff'),
        plotId: id,
        baseRound,
        targetRound,
        treeNo,
        species: t?.species ?? b?.species ?? '',
        baseDbhCm: baseDbh,
        targetDbhCm: targetDbh,
        baseHeightM: b?.heightM,
        targetHeightM: t?.heightM,
        dbhGrowth,
        heightGrowth,
        statusChange,
        missingReason,
        generatedAt: Date.now(),
      };
    });

    setDiffs(next);
    setError('');
    setToast(`已生成第 ${baseRound} 期 → 第 ${targetRound} 期的逐株比对表，共 ${next.length} 条`);
  };

  const save = async () => {
    if (diffs.length === 0) {
      setError('请先生成比对表');
      return;
    }
    // 重算保存：覆盖该两期旧比对（含已失效旧值），该两期的失效计数同步清零
    const replacedStale = (
      await loadRecheckDiffs(id)
    ).filter(
      (d) => d.baseRound === baseRound && d.targetRound === targetRound && d.stale === true,
    ).length;
    await replaceRecheckDiffs(id, baseRound, targetRound, diffs);
    setStaleCount((prev) => Math.max(0, prev - replacedStale));
    setToast(`逐株比对表已写入本地档案库（${diffs.length} 条），已替换该两期旧结果`);
  };

  const activeDiffs = diffs.filter((d) => d.stale !== true);
  const staleInView = diffs.length - activeDiffs.length;
  const abnormal = activeDiffs.filter(isDiffAbnormal).length;
  const missing = activeDiffs.filter((d) => !d.targetDbhCm).length;
  const avgRate =
    activeDiffs.filter((d) => d.targetDbhCm).length === 0
      ? 0
      : r2(
          activeDiffs.filter((d) => d.targetDbhCm).reduce((s, d) => s + growthRate(d), 0) /
            activeDiffs.filter((d) => d.targetDbhCm).length,
        );

  if (!plot) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该样地" />
        <Link to="/plots">返回样地台账</Link>
      </Space>
    );
  }

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          复查比对 · {plot.plotNo}
        </Typography.Title>
        <RoundTag round={plot.surveyRound} locked={plot.locked} />
        <Tag>样地面积 {plot.area} m²</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/plots/${plot.id}/trees`}>样木录入</Link>
        </Button>
        <Button type="link">
          <Link to={`/plots/${plot.id}/correction`}>编号校正</Link>
        </Button>
        <Button type="link">
          <Link to={`/plots/${plot.id}/regen`}>更新与灌木</Link>
        </Button>
        <Button type="link">
          <Link to={`/summary/${plot.id}`}>林分汇总</Link>
        </Button>
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}

      {(roundBlocked(baseRound) || roundBlocked(targetRound)) && (
        <Alert
          type="error"
          showIcon
          message="期内重复树号未处理，复查比对已暂停"
          description={
            <Space direction="vertical" size={2}>
              <span>
                第 {baseRound} 期重复树号：{duplicateNosInRound(baseRound).join('、') || '无'}；第 {targetRound}{' '}
                期重复树号：{duplicateNosInRound(targetRound).join('、') || '无'}。
              </span>
              <span>按树号硬配会把两株并成一条、生长量跨株，须先完成编号校正。</span>
              <Button size="small" type="primary" danger>
                <Link to={`/plots/${plot.id}/correction`}>前往编号校正</Link>
              </Button>
            </Space>
          }
        />
      )}

      {staleCount > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`有 ${staleCount} 条历史复查结果因编号校正已失效（旧生长量可能跨株），请按校正后档案重新生成并保存；汇总与导出在失效清零前暂停旧值`}
          action={
            <Button size="small">
              <Link to={`/plots/${plot.id}/correction`}>查看编号校正</Link>
            </Button>
          }
        />
      )}
      {staleCount === 0 && staleInView > 0 && (
        <Alert type="info" showIcon message="下方为本次新生成的比对表，保存后将替换对应两期的已失效结果。" />
      )}

      <Card size="small">
        <Space wrap size={10}>
          <span>
            上期
            <Select
              style={{ width: 120, marginLeft: 6 }}
              value={baseRound}
              onChange={setBaseRound}
              options={rounds.map((r) => ({ value: r, label: `第 ${r} 期` }))}
            />
          </span>
          <span>
            本期
            <Select
              style={{ width: 120, marginLeft: 6 }}
              value={targetRound}
              onChange={setTargetRound}
              options={rounds.map((r) => ({ value: r, label: `第 ${r} 期` }))}
            />
          </span>
          <Button
            type="primary"
            onClick={generate}
            disabled={roundBlocked(baseRound) || roundBlocked(targetRound)}
          >
            生成逐株比对表
          </Button>
          <Button
            icon={<SaveOutlined />}
            onClick={save}
            disabled={roundBlocked(baseRound) || roundBlocked(targetRound)}
          >
            保存比对结果
          </Button>
          <Typography.Text type="secondary">
            可选期次：{rounds.length === 0 ? '暂无数据' : rounds.map((r) => `第 ${r} 期`).join('、')}
          </Typography.Text>
        </Space>
      </Card>

      <Row gutter={12}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="比对数" value={diffs.length} suffix="株" />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="平均保留木生长率" value={avgRate} precision={2} suffix="%" />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="缺测 / 无法匹配" value={missing} suffix="株" />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="异常标注" value={abnormal} suffix="条" />
          </Card>
        </Col>
      </Row>

      <Card size="small" title="两期逐株差值表">
        <GrowthDiffTable diffs={diffs} />
      </Card>
    </Space>
  );
}
