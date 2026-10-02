import { db } from './db';
import {
  editOfRecord,
  emptyDraft,
  evaluateCorrection,
  gapConfirmKey,
  type CorrectionDraftData,
} from '../types/correction';
import type { TreeRecord } from '../types/tree';

const DRAFT_KEY_PREFIX = 'gbforestplot:correction-draft:';
const RESOLVED_GAP_PREFIX = 'gbforestplot:gap-resolved:';

/** 历次校正已核对确认的跨缺测期重现株线（按校正后树号存档） */
export function loadResolvedGapKeys(plotId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(RESOLVED_GAP_PREFIX + plotId);
    const arr = raw ? (JSON.parse(raw) as string[]) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveResolvedGapKeys(plotId: string, keys: Set<string>): void {
  try {
    window.localStorage.setItem(RESOLVED_GAP_PREFIX + plotId, JSON.stringify(Array.from(keys)));
  } catch {
    /* localStorage 不可用时忽略，已写入档案的校正不受影响 */
  }
}

/** 读取编号校正草稿（整组确认前不入库，仅本地保留，失败/刷新后可接着做） */
export function loadCorrectionDraft(plotId: string): CorrectionDraftData {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY_PREFIX + plotId);
    if (!raw) return emptyDraft();
    const parsed = JSON.parse(raw) as CorrectionDraftData;
    return {
      edits: parsed.edits ?? {},
      gapConfirmed: parsed.gapConfirmed ?? {},
      updatedAt: parsed.updatedAt ?? 0,
    };
  } catch {
    return emptyDraft();
  }
}

/** 保存草稿 */
export function saveCorrectionDraft(plotId: string, draft: CorrectionDraftData): void {
  try {
    window.localStorage.setItem(
      DRAFT_KEY_PREFIX + plotId,
      JSON.stringify({ ...draft, updatedAt: Date.now() }),
    );
  } catch {
    /* localStorage 不可用时草稿仅保留在页面内存 */
  }
}

/** 丢弃草稿（整组确认提交成功后调用） */
export function clearCorrectionDraft(plotId: string): void {
  try {
    window.localStorage.removeItem(DRAFT_KEY_PREFIX + plotId);
  } catch {
    /* 忽略 */
  }
}

export interface CorrectionCommitResult {
  updated: number;
  voided: number;
  invalidated: number;
  affectedTreeNos: string[];
}

export class CorrectionBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorrectionBlockedError';
  }
}

/**
 * 整组一次性提交编号校正，全程在单个读写事务内：
 * 1. 先跑校验：期内重复树号、改号后冲突、空树号、跨缺测重现未确认一律拦住；
 * 2. 改写受影响样木树号，作废重复/误录条；
 * 3. 引用旧号或新号的复查比对立即置 stale（生长量可能跨株），待重算。
 * 任一步失败 Dexie 自动回滚，trees/rechecks 恢复原档案；草稿仍保留可接着改。
 */
export async function commitCorrection(
  plotId: string,
  draft: CorrectionDraftData,
): Promise<CorrectionCommitResult> {
  return db.transaction('rw', db.trees, db.rechecks, async () => {
    const trees = await db.trees.where('plotId').equals(plotId).toArray();
    const evaluation = evaluateCorrection(trees, draft, loadResolvedGapKeys(plotId));

    if (evaluation.hardErrorCount > 0) {
      throw new CorrectionBlockedError(
        `仍有 ${evaluation.hardErrorCount} 处硬拦截问题（期内重复/改号冲突/跨缺测未确认），请处理后再提交`,
      );
    }
    if (evaluation.changeCount === 0) {
      throw new CorrectionBlockedError('没有检测到任何编号改动');
    }

    // 受影响树号：改动记录的旧号与新号都纳入，相关复查一律失效
    const affected = new Set<string>();
    const updates: { id: string; treeNo: string }[] = [];
    const voidIds: string[] = [];

    trees.forEach((rec: TreeRecord) => {
      const edit = editOfRecord(rec, draft);
      if (edit.action === 'void') {
        voidIds.push(rec.id);
        affected.add(rec.treeNo);
        return;
      }
      const targetNo = edit.targetNo.trim();
      if (targetNo !== rec.treeNo) {
        updates.push({ id: rec.id, treeNo: targetNo });
        affected.add(rec.treeNo);
        affected.add(targetNo);
      }
    });

    await Promise.all(updates.map((u) => db.trees.update(u.id, { treeNo: u.treeNo })));
    if (voidIds.length > 0) await db.trees.bulkDelete(voidIds);

    const rechecks = await db.rechecks.where('plotId').equals(plotId).toArray();
    const now = Date.now();
    const affectedList = Array.from(affected);
    const toInvalidate = rechecks.filter(
      (d) => d.stale !== true && affected.has(d.treeNo),
    );
    await Promise.all(
      toInvalidate.map((d) =>
        db.rechecks.update(d.id, {
          stale: true,
          staleAt: now,
          staleReason: `编号校正影响树号：${affectedList.join('、')}；旧生长量可能跨株，待重算`,
        }),
      ),
    );

    return {
      updated: updates.length,
      voided: voidIds.length,
      invalidated: toInvalidate.length,
      affectedTreeNos: affectedList,
    };
  });
}

/**
 * 提交成功后固化本次新确认的缺测重现株线（按校正后目标树号存档）。
 * 在事务外调用；localStorage 失败不影响已落库的校正。
 */
export function persistConfirmedGaps(
  plotId: string,
  trees: TreeRecord[],
  draft: CorrectionDraftData,
): void {
  const evaluation = evaluateCorrection(trees, draft, loadResolvedGapKeys(plotId));
  const resolved = loadResolvedGapKeys(plotId);
  let added = 0;
  evaluation.groups.forEach((g) => {
    g.chains.forEach((c) => {
      if (c.hasGap && c.gapConfirmed) {
        const persisted = gapConfirmKey(c.targetNo, c.targetNo);
        if (!resolved.has(persisted)) {
          resolved.add(persisted);
          added += 1;
        }
      }
    });
  });
  if (added > 0) saveResolvedGapKeys(plotId, resolved);
}
