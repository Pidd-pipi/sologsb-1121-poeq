import type { TreeRecord } from './tree';

/** 单条样木记录的校正处置 */
export type RecordAction = 'keep' | 'void';

export interface RecordEditState {
  /** 划归到的目标树号（拆分/合并时与原树号不同） */
  targetNo: string;
  /** keep = 保留；void = 作废（重复/误录，提交时删除该条） */
  action: RecordAction;
}

/** 编号校正草稿（整组确认前不落档案，仅存草稿） */
export interface CorrectionDraftData {
  /** 按样木记录 id 索引的编辑项；未出现在表中的记录视为原样保留 */
  edits: Record<string, RecordEditState>;
  /** 跨缺测期重现确认，键为 `${原树号}::${目标树号}`，改号后键变即需重新确认 */
  gapConfirmed: Record<string, boolean>;
  updatedAt: number;
}

export function emptyDraft(): CorrectionDraftData {
  return { edits: {}, gapConfirmed: {}, updatedAt: 0 };
}

export function editOfRecord(rec: TreeRecord, draft: CorrectionDraftData): RecordEditState {
  return draft.edits[rec.id] ?? { targetNo: rec.treeNo, action: 'keep' };
}

/** 跨缺测期重现确认键（与目标树号绑定，改号即失效） */
export function gapConfirmKey(sourceNo: string, targetNo: string): string {
  return `${sourceNo}::${targetNo}`;
}

export type IssueLevel = 'error' | 'warning';

export type IssueKind =
  /** 原始档案中同一期内树号重复：硬拦截，必须先拆分或作废 */
  | 'source-duplicate'
  /** 校正后同一期内目标树号仍重复：硬拦截 */
  | 'target-duplicate'
  /** 划归树号为空 */
  | 'empty-target'
  /** 跨缺测期后树号重新出现：核对现场号牌/位置后逐条确认 */
  | 'gap-reappear'
  /** 同一条线上树种不一致：疑似两株并一号 */
  | 'species-mismatch'
  /** 位置描述不一致：疑似串株 */
  | 'location-mismatch'
  /** 相邻可比重测期胸径回退：疑似两株并一号 */
  | 'dbh-drop';

export interface CorrectionIssue {
  level: IssueLevel;
  kind: IssueKind;
  /** 相关期次（可空） */
  round?: number;
  /** 相关目标树号（可空，取原树号时表示整组） */
  targetNo?: string;
  message: string;
}

/** 同组记录按目标树号归并出的一条「株线」（同一株应有的各期记录） */
export interface CorrectionChain {
  targetNo: string;
  /** 该株线保留的记录，按期次升序 */
  records: TreeRecord[];
  /** 该株线是否存在跨缺测期重现 */
  hasGap: boolean;
  gapConfirmed: boolean;
}

export interface CorrectionGroup {
  /** 原始树号（校正前硬配所用编号） */
  sourceNo: string;
  /** 该树号下的全部记录（含将作废的），按期次升序 */
  records: TreeRecord[];
  /** 按目标树号拆出的株线 */
  chains: CorrectionChain[];
  /** 本组建档期次内重复的期次 */
  duplicateRounds: number[];
  issues: CorrectionIssue[];
}

export interface CorrectionEvaluation {
  /** 保留记录所覆盖的全部期次（升序） */
  rounds: number[];
  groups: CorrectionGroup[];
  /** 期内重复、改号冲突、空树号等硬拦截条数 */
  hardErrorCount: number;
  /** 待人工确认的跨缺测期重现条数 */
  gapPendingCount: number;
  /** 树种/位置/胸径回退等疑点条数 */
  warningCount: number;
  /** 涉及改动的记录条数（改号或作废） */
  changeCount: number;
  renameCount: number;
  voidCount: number;
}

function sortByRound(records: TreeRecord[]): TreeRecord[] {
  return [...records].sort((a, b) => a.round - b.round || a.id.localeCompare(b.id));
}

/**
 * 编号校正审计：
 * 1. 按原始树号分组，并排列出每期记录（胸径/树高/位置/状态）；
 * 2. 期内重复树号直接报错拦住；
 * 3. 按草稿把记录划归目标树号形成株线，检查校正后冲突；
 * 4. 株线内查树种/位置/胸径回退疑点，跨缺测期重现要求逐条确认。
 *
 * @param resolvedGapKeys 历次校正已确认过的缺测重现株线（键 `${树号}::${树号}`，
 * 按校正后档案编号落库；新草稿里的确认仍以 `${原树号}::${目标树号}` 为键）
 */
export function evaluateCorrection(
  plotTrees: TreeRecord[],
  draft: CorrectionDraftData,
  resolvedGapKeys: Set<string> = new Set(),
): CorrectionEvaluation {
  const kept = plotTrees.filter((t) => editOfRecord(t, draft).action !== 'void');

  const roundSet = new Set<number>();
  kept.forEach((t) => roundSet.add(t.round));
  const rounds = Array.from(roundSet).sort((a, b) => a - b);

  const sourceMap = new Map<string, TreeRecord[]>();
  plotTrees.forEach((t) => {
    const arr = sourceMap.get(t.treeNo) ?? [];
    arr.push(t);
    sourceMap.set(t.treeNo, arr);
  });

  const groups: CorrectionGroup[] = [];
  let hardErrorCount = 0;
  let warningCount = 0;
  let renameCount = 0;
  let voidCount = 0;

  // 跨组统计：同一目标树号 + 同一期次只能有一条保留记录
  const targetSlots = new Map<string, { sourceNo: string; rec: TreeRecord }[]>();

  for (const [sourceNo, rawRecords] of Array.from(sourceMap.entries()).sort((a, b) =>
    a[0].localeCompare(b[0], 'zh-Hans-CN', { numeric: true }),
  )) {
    const records = sortByRound(rawRecords);
    const issues: CorrectionIssue[] = [];

    // 原始期内重复（已作废的误录条不再计为冲突：作废即解除拦截）
    const roundCount = new Map<number, number>();
    records
      .filter((r) => editOfRecord(r, draft).action !== 'void')
      .forEach((r) => roundCount.set(r.round, (roundCount.get(r.round) ?? 0) + 1));
    const duplicateRounds = Array.from(roundCount.entries())
      .filter(([, n]) => n > 1)
      .map(([r]) => r)
      .sort((a, b) => a - b);
    duplicateRounds.forEach((r) => {
      issues.push({
        level: 'error',
        kind: 'source-duplicate',
        round: r,
        message: `原始档案第 ${r} 期树号 ${sourceNo} 有 ${roundCount.get(r)} 条记录（期内重复），复查硬配已拦截，请拆分或作废其中误录条`,
      });
      hardErrorCount += 1;
    });

    // 按目标树号组株线
    const chainMap = new Map<string, TreeRecord[]>();
    records.forEach((r) => {
      const edit = editOfRecord(r, draft);
      if (edit.action === 'void') return;
      const no = edit.targetNo.trim();
      const arr = chainMap.get(no) ?? [];
      arr.push(r);
      chainMap.set(no, arr);
    });

    const chains: CorrectionChain[] = [];
    for (const [targetNo, chainRecsRaw] of chainMap) {
      const chainRecs = sortByRound(chainRecsRaw);
      if (!targetNo) {
        issues.push({
          level: 'error',
          kind: 'empty-target',
          targetNo,
          message: `树号 ${sourceNo} 有记录划归到空树号，请填写目标树号`,
        });
        hardErrorCount += 1;
      }

      // 跨缺测期重现：株线最早与最晚出现期之间，存在样地有期次而本株线缺测
      const presentRounds = new Set(chainRecs.map((r) => r.round));
      const minR = chainRecs[0].round;
      const maxR = chainRecs[chainRecs.length - 1].round;
      const missing = rounds.filter((r) => r > minR && r < maxR && !presentRounds.has(r));
      const hasGap = missing.length > 0;
      const key = gapConfirmKey(sourceNo, targetNo);
      const persistedKey = gapConfirmKey(targetNo, targetNo);
      const gapConfirmed =
        Boolean(draft.gapConfirmed[key]) || resolvedGapKeys.has(persistedKey);

      // 树种不一致
      const speciesSet = new Set(chainRecs.map((r) => r.species.trim()).filter(Boolean));
      if (targetNo && speciesSet.size > 1) {
        issues.push({
          level: 'warning',
          kind: 'species-mismatch',
          targetNo,
          message: `划归 ${targetNo} 号的各期树种不一致（${Array.from(speciesSet).join(' / ')}），疑似把两株并成一条`,
        });
        warningCount += 1;
      }

      // 位置不一致
      const locSet = new Set(chainRecs.map((r) => r.remark.trim()).filter(Boolean));
      if (targetNo && locSet.size > 1) {
        issues.push({
          level: 'warning',
          kind: 'location-mismatch',
          targetNo,
          message: `划归 ${targetNo} 号的位置描述不一致（${Array.from(locSet).join(' / ')}），请核对现场号牌`,
        });
        warningCount += 1;
      }

      // 相邻可比重测期胸径回退
      for (let i = 1; i < chainRecs.length; i += 1) {
        const prev = chainRecs[i - 1];
        const cur = chainRecs[i];
        if (targetNo && cur.dbhCm < prev.dbhCm) {
          issues.push({
            level: 'warning',
            kind: 'dbh-drop',
            round: cur.round,
            targetNo,
            message: `${targetNo} 号第 ${prev.round}→${cur.round} 期胸径 ${prev.dbhCm}→${cur.dbhCm} cm 回退，疑似两株并一号`,
          });
          warningCount += 1;
        }
      }

      if (targetNo && hasGap && !gapConfirmed) {
        issues.push({
          level: 'error',
          kind: 'gap-reappear',
          targetNo,
          message: `${targetNo} 号在第 ${missing.join('、')} 期缺测后又出现，请核对现场号牌与位置并逐条确认`,
        });
      }

      chainRecs.forEach((rec) => {
        const slotKey = `${targetNo}__${rec.round}`;
        const arr = targetSlots.get(slotKey) ?? [];
        arr.push({ sourceNo, rec });
        targetSlots.set(slotKey, arr);
      });

      chains.push({ targetNo, records: chainRecs, hasGap, gapConfirmed });
    }

    records.forEach((r) => {
      const edit = editOfRecord(r, draft);
      if (edit.action === 'void') voidCount += 1;
      else if (edit.targetNo.trim() !== r.treeNo) renameCount += 1;
    });

    chains.sort((a, b) => a.targetNo.localeCompare(b.targetNo, 'zh-Hans-CN', { numeric: true }));
    groups.push({ sourceNo, records, chains, duplicateRounds, issues });
  }

  // 校正后目标树号期内冲突（可能跨原树号：合并时产生）
  let gapPendingCount = 0;
  groups.forEach((g) => {
    g.chains.forEach((c) => {
      if (c.hasGap && !c.gapConfirmed) gapPendingCount += 1;
    });
  });

  targetSlots.forEach((entries, slotKey) => {
    if (entries.length <= 1) return;
    const [targetNo, roundStr] = slotKey.split('__');
    const round = Number(roundStr);
    const sources = Array.from(new Set(entries.map((e) => e.sourceNo)));
    const involved = new Set(groups.filter((g) => sources.includes(g.sourceNo)));
    involved.forEach((g) => {
      g.issues.push({
        level: 'error',
        kind: 'target-duplicate',
        round,
        targetNo,
        message: `第 ${round} 期树号 ${targetNo} 校正后仍有 ${entries.length} 条记录（来自原树号 ${sources.join('、')}），请继续拆分或作废`,
      });
      hardErrorCount += 1;
    });
  });

  const changeCount = renameCount + voidCount;
  return {
    rounds,
    groups,
    hardErrorCount,
    gapPendingCount,
    warningCount,
    changeCount,
    renameCount,
    voidCount,
  };
}
