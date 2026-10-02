import type { TreeRecord } from './tree';

/**
 * 样木身份校正组：把跨期、跨树号的记录归并为同一株树。
 * 同一株被拆成两条（同株异号）→ 并入一组；
 * 两株并成一条（异株同号）→ 拆出改号、移出组。
 */
export interface TreeGroup {
  id: string;
  plotId: string;
  /** 校正后统一树号（组内各期记录视为同一株树） */
  canonicalTreeNo: string;
  /** 组内样木记录 id */
  memberTreeIds: string[];
  /** 草稿中对个别记录的改号：recordId -> 新树号（确认时随整组一起生效） */
  treeNoOverrides?: Record<string, string>;
  /** draft=草稿（可继续修改）；confirmed=已确认并生效，复查按组匹配 */
  status: 'draft' | 'confirmed';
  note: string;
  createdAt: number;
  confirmedAt?: number;
}

export type TreeGroupDraft = Omit<TreeGroup, 'id' | 'createdAt' | 'status'> & {
  id?: string;
  status?: 'draft' | 'confirmed';
};

/** 复查结果新鲜度：样木编号校正后旧结果失效、待重算 */
export interface RecheckState {
  /** 样地 id（主键） */
  plotId: string;
  /** fresh=比对结果有效；stale=样木编号已变更，引用这些样木的复查结果已失效待重算 */
  status: 'fresh' | 'stale';
  invalidatedAt?: number;
  reason?: string;
}

/** 校正发现的问题 */
export interface TreeIssue {
  key: string;
  type: 'duplicate' | 'reappear' | 'suspect';
  plotId: string;
  treeNo: string;
  rounds: number[];
  recordIds: string[];
  /** block=期内重号必须先拦住；warn=跨期再现/疑似串株需重新确认 */
  severity: 'block' | 'warn';
  message: string;
}

/** 候选同株建议 */
export interface CandidateSuggestion {
  record: TreeRecord;
  reason: string;
  score: number;
}

/**
 * 记录的身份键：
 * 已确认校正组内的记录按组归并（g:<groupId>），其余按树号硬匹配（n:<treeNo>）。
 */
export function identityKeyOf(record: TreeRecord, groups: TreeGroup[]): string {
  const g = groups.find((x) => x.status === 'confirmed' && x.memberTreeIds.includes(record.id));
  return g ? `g:${g.id}` : `n:${record.treeNo}`;
}

/** 身份键对应的组统一树号（非组身份返回 null） */
export function groupCanonical(key: string, groups: TreeGroup[]): string | null {
  if (!key.startsWith('g:')) return null;
  const g = groups.find((x) => x.id === key.slice(2));
  return g ? g.canonicalTreeNo : null;
}

/** 检测样木编号问题：期内重号、跨缺测期再现、疑似串株 */
export function detectTreeIssues(plotId: string, trees: TreeRecord[], groups: TreeGroup[]): TreeIssue[] {
  const issues: TreeIssue[] = [];
  const resolved = new Set(
    groups.filter((g) => g.status === 'confirmed').flatMap((g) => g.memberTreeIds),
  );
  const mine = trees.filter((t) => t.plotId === plotId);

  // 1. 期内重号（拦截级）：同一期同一树号出现多条记录
  const byRoundNo = new Map<string, TreeRecord[]>();
  mine.forEach((t) => {
    const key = `${t.round}__${t.treeNo}`;
    const arr = byRoundNo.get(key) ?? [];
    arr.push(t);
    byRoundNo.set(key, arr);
  });
  byRoundNo.forEach((arr, key) => {
    if (arr.length > 1) {
      const [round, treeNo] = key.split('__');
      issues.push({
        key: `dup-${round}-${treeNo}`,
        type: 'duplicate',
        plotId,
        treeNo,
        rounds: [Number(round)],
        recordIds: arr.map((t) => t.id),
        severity: 'block',
        message: `第 ${round} 期树号 ${treeNo} 重复出现 ${arr.length} 条记录，期内重号必须先拦住`,
      });
    }
  });

  // 按树号汇总各期
  const byNo = new Map<string, TreeRecord[]>();
  mine.forEach((t) => {
    const arr = byNo.get(t.treeNo) ?? [];
    arr.push(t);
    byNo.set(t.treeNo, arr);
  });

  byNo.forEach((arr, treeNo) => {
    const rounds = Array.from(new Set(arr.map((t) => t.round))).sort((a, b) => a - b);

    // 2. 跨缺测期再现：中间缺测一期或多期后树号又出现，需重新确认
    let gap = false;
    for (let i = 1; i < rounds.length; i += 1) {
      if (rounds[i] > rounds[i - 1] + 1) {
        gap = true;
        break;
      }
    }
    if (gap && !arr.some((t) => resolved.has(t.id))) {
      issues.push({
        key: `reappear-${treeNo}`,
        type: 'reappear',
        plotId,
        treeNo,
        rounds,
        recordIds: arr.map((t) => t.id),
        severity: 'warn',
        message: `树号 ${treeNo} 跨缺测期再现（第 ${rounds.join('、')} 期出现，中间有缺测），需重新确认是否同一株`,
      });
    }

    // 3. 疑似串株：相邻期同树号但树种不同或胸径/树高异常缩水
    for (let i = 1; i < rounds.length; i += 1) {
      const r1 = rounds[i - 1];
      const r2 = rounds[i];
      if (r2 !== r1 + 1) continue;
      const a = arr.find((t) => t.round === r1);
      const b = arr.find((t) => t.round === r2);
      if (!a || !b) continue;
      if (resolved.has(a.id) || resolved.has(b.id)) continue;
      const speciesChanged = a.species !== b.species;
      const dbhShrink = b.dbhCm < a.dbhCm * 0.7;
      const heightShrink = b.heightM < a.heightM * 0.7;
      if (speciesChanged || dbhShrink || heightShrink) {
        const reasons = [
          speciesChanged ? `树种 ${a.species} → ${b.species}` : '',
          dbhShrink ? `胸径 ${a.dbhCm} → ${b.dbhCm} cm 异常缩水` : '',
          heightShrink ? `树高 ${a.heightM} → ${b.heightM} m 异常缩水` : '',
        ].filter(Boolean);
        issues.push({
          key: `suspect-${treeNo}-${r1}-${r2}`,
          type: 'suspect',
          plotId,
          treeNo,
          rounds: [r1, r2],
          recordIds: [a.id, b.id],
          severity: 'warn',
          message: `树号 ${treeNo} 第 ${r1} → ${r2} 期疑似串株（${reasons.join('；')}），按树号硬配生长量会跨株`,
        });
      }
    }
  });

  return issues;
}

/** 候选同株建议：同树种、生长连续、位置相近 */
export function suggestCandidates(
  anchor: TreeRecord,
  all: TreeRecord[],
  memberIds: Set<string>,
  limit = 5,
): CandidateSuggestion[] {
  const pool = all.filter(
    (t) => t.plotId === anchor.plotId && t.id !== anchor.id && !memberIds.has(t.id),
  );
  const scored: CandidateSuggestion[] = [];
  pool.forEach((cand) => {
    if (cand.species !== anchor.species) return;
    if (cand.round === anchor.round) return; // 同期不同株不建议
    const earlier = cand.round < anchor.round;
    const [small, big] = earlier ? [cand, anchor] : [anchor, cand];
    const dbhRatio = big.dbhCm / small.dbhCm;
    const heightRatio = big.heightM / small.heightM;
    // 正常生长应随期增大，比值在合理区间
    if (dbhRatio < 0.95 || dbhRatio > 2.6) return;
    if (heightRatio < 0.95 || heightRatio > 2.2) return;
    let score = 60;
    score -= Math.abs(dbhRatio - 1.4) * 20;
    score -= Math.abs(heightRatio - 1.3) * 20;
    let reason = `同树种，胸径 ${small.dbhCm} → ${big.dbhCm} cm 连续`;
    // 位置相近（备注含相同片段）
    if (anchor.remark && cand.remark) {
      const common = anchor.remark
        .split('')
        .filter((ch) => ch !== ' ' && ch !== '号' && cand.remark.includes(ch)).length;
      if (common >= 4) {
        score += 12;
        reason += '，位置描述相近';
      }
    }
    scored.push({ record: cand, reason, score: Math.round(score) });
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 校正后某记录应使用的树号（改号覆盖优先，否则用统一树号） */
export function effectiveTreeNo(
  record: TreeRecord,
  canonical: string,
  overrides: Record<string, string>,
): string {
  return (overrides[record.id] ?? canonical).trim();
}

/** 校正生效后某记录的树号（供撞号检查） */
function effectiveAfter(
  record: TreeRecord,
  memberIds: string[],
  canonical: string,
  overrides: Record<string, string>,
): string {
  if (!memberIds.includes(record.id)) return record.treeNo.trim();
  return (overrides[record.id] ?? canonical).trim();
}

/**
 * 校验确认后是否会出现必须拦截的同期重号：
 * - 统一树号或显式改号为空；
 * - 两条成员记录同期且原树号相同（真·期内重号，必须改号）；
 * - 显式改号与同期任何记录（含成员/非成员）撞号。
 * 成员同期但原树号不同（同株同期多条）不拦截，见 correctionWarnings。
 * 返回错误信息（无问题返回 null）。
 */
export function validateCorrection(
  trees: TreeRecord[],
  plotId: string,
  memberIds: string[],
  canonical: string,
  overrides: Record<string, string>,
): string | null {
  const mine = trees.filter((t) => t.plotId === plotId);
  if (!canonical.trim()) return '统一树号不能为空';
  for (const no of Object.values(overrides)) {
    if (!no.trim()) return '改号不能为空';
  }
  const members = mine.filter((t) => memberIds.includes(t.id));

  // 成员之间同期撞号
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const a = members[i];
      const b = members[j];
      if (a.round !== b.round) continue;
      if (
        effectiveAfter(a, memberIds, canonical, overrides) !==
        effectiveAfter(b, memberIds, canonical, overrides)
      ) {
        continue;
      }
      if (a.treeNo.trim() === b.treeNo.trim()) {
        // 原树号相同：真·期内重号，保留原号也无法消除，必须改号
        return `第 ${a.round} 期树号 ${a.treeNo} 期内重复出现，请将其中一株改号或移除`;
      }
      // 原树号不同（同株同期多条）：保留原号、按同株归并，软处理
    }
  }

  // 显式改号不得与同期任何记录撞号
  for (const [id, no] of Object.entries(overrides)) {
    const m = mine.find((t) => t.id === id);
    if (!m) continue;
    const target = no.trim();
    const collide = mine.some(
      (t) =>
        t.id !== id &&
        t.round === m.round &&
        effectiveAfter(t, memberIds, canonical, overrides) === target,
    );
    if (collide) {
      return `第 ${m.round} 期改号 ${target} 与同期树号冲突，请调整`;
    }
  }

  return null;
}

/** 软警告（不拦截）：同株同期多条保留原号、统一树号与非成员同期树号冲突 */
export function correctionWarnings(
  trees: TreeRecord[],
  plotId: string,
  memberIds: string[],
  canonical: string,
  overrides: Record<string, string>,
): string[] {
  const mine = trees.filter((t) => t.plotId === plotId);
  const warnings: string[] = [];
  const members = mine.filter((t) => memberIds.includes(t.id));

  // 成员同期撞号但原树号不同 → 保留原号归并
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const a = members[i];
      const b = members[j];
      if (a.round !== b.round) continue;
      if (
        effectiveAfter(a, memberIds, canonical, overrides) ===
          effectiveAfter(b, memberIds, canonical, overrides) &&
        a.treeNo.trim() !== b.treeNo.trim()
      ) {
        warnings.push(
          `第 ${a.round} 期 ${a.treeNo} 与 ${b.treeNo} 为同株同期多条记录，将保留原树号归并（复查标「同期多条记录」）`,
        );
      }
    }
  }

  // 统一树号与非成员同期树号冲突 → 成员保留原号归并
  for (const m of members) {
    if (overrides[m.id]) continue;
    const target = canonical.trim();
    if (!target || target === m.treeNo.trim()) continue;
    const collide = mine.some(
      (t) =>
        !memberIds.includes(t.id) &&
        t.round === m.round &&
        t.treeNo.trim() === target,
    );
    if (collide) {
      warnings.push(
        `第 ${m.round} 期统一树号 ${target} 已被同期其他样木占用，${m.treeNo} 将保留原树号归并`,
      );
    }
  }

  return warnings;
}
