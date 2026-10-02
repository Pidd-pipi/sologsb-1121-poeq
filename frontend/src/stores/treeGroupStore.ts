import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { validateCorrection, type TreeGroup, type TreeGroupDraft } from '../types/treeGroup';

export interface ConfirmResult {
  ok: boolean;
  /** 失败原因（事务已回滚，草稿保留） */
  error?: string;
}

interface TreeGroupState {
  groups: TreeGroup[];
  loadedPlot: string | null;
  load: (plotId: string) => Promise<void>;
  /** 草稿独立落库：后续确认事务失败时草稿不丢，修正后可接着做 */
  saveDraft: (draft: TreeGroupDraft) => Promise<TreeGroup>;
  removeDraft: (id: string) => Promise<void>;
  /** 整组确认：改号 + 生效 + 失效复查结果，一个事务完成；失败回滚、草稿保留 */
  confirm: (plotId: string, draft: TreeGroupDraft) => Promise<ConfirmResult>;
}

export const useTreeGroupStore = create<TreeGroupState>((set, get) => ({
  groups: [],
  loadedPlot: null,
  async load(plotId) {
    const rows = await db.treeGroups.where('plotId').equals(plotId).toArray();
    rows.sort((a, b) => b.createdAt - a.createdAt);
    set({ groups: rows, loadedPlot: plotId });
  },
  async saveDraft(draft) {
    const record: TreeGroup = {
      id: draft.id ?? newId('group'),
      plotId: draft.plotId,
      canonicalTreeNo: draft.canonicalTreeNo.trim(),
      memberTreeIds: draft.memberTreeIds,
      treeNoOverrides: draft.treeNoOverrides ?? {},
      status: 'draft',
      note: draft.note ?? '',
      createdAt: Date.now(),
    };
    await db.treeGroups.put(record);
    set({ groups: [record, ...get().groups.filter((g) => g.id !== record.id)] });
    return record;
  },
  async removeDraft(id) {
    await db.treeGroups.delete(id);
    set({ groups: get().groups.filter((g) => g.id !== id) });
  },
  async confirm(plotId, draft) {
    const trees = await db.trees.where('plotId').equals(plotId).toArray();

    // 1. 草稿先落库（独立事务）：无论校验失败还是事务回滚，草稿都保留，修正后可接着做
    const group: TreeGroup = {
      id: draft.id ?? newId('group'),
      plotId,
      canonicalTreeNo: draft.canonicalTreeNo.trim(),
      memberTreeIds: draft.memberTreeIds,
      treeNoOverrides: draft.treeNoOverrides ?? {},
      status: 'draft',
      note: draft.note ?? '',
      createdAt: Date.now(),
    };
    await db.treeGroups.put(group);
    set({ groups: [group, ...get().groups.filter((g) => g.id !== group.id)] });

    // 2. 期内重号先拦住（不进入事务）
    const validation = validateCorrection(
      trees,
      plotId,
      draft.memberTreeIds,
      draft.canonicalTreeNo,
      draft.treeNoOverrides ?? {},
    );
    if (validation) return { ok: false, error: validation };

    const members = trees.filter((t) => draft.memberTreeIds.includes(t.id));
    const affected = new Set<string>([group.canonicalTreeNo]);
    members.forEach((m) => {
      affected.add(m.treeNo);
      const ov = group.treeNoOverrides?.[m.id];
      if (ov) affected.add(ov);
    });

    try {
      // 3. 整组事务：改号、生效、失效复查结果、标记待重算，要么全成要么全回滚
      await db.transaction(
        'rw',
        db.trees,
        db.treeGroups,
        db.rechecks,
        db.recheckState,
        async () => {
          for (const m of members) {
            const explicit = group.treeNoOverrides?.[m.id];
            const next = explicit ?? group.canonicalTreeNo;
            if (next === m.treeNo) continue;
            // 与同期其他记录校正后的树号撞号？
            const collision = trees.some((t) => {
              if (t.id === m.id || t.round !== m.round) return false;
              const tNext = group.memberTreeIds.includes(t.id)
                ? (group.treeNoOverrides?.[t.id] ?? group.canonicalTreeNo)
                : t.treeNo;
              return tNext === next;
            });
            if (collision) {
              if (explicit) {
                throw new Error(`第 ${m.round} 期改号 ${next} 与同期树号冲突，事务回滚`);
              }
              // 统一树号撞号（同株同期多条）：保留原树号，仍按身份组归并
              continue;
            }
            await db.trees.update(m.id, { treeNo: next });
          }
          await db.treeGroups.update(group.id, {
            status: 'confirmed',
            confirmedAt: Date.now(),
          });
          // 引用这些样木的复查结果立即失效
          const diffs = await db.rechecks.where('plotId').equals(plotId).toArray();
          const stale = diffs.filter((d) => affected.has(d.treeNo));
          if (stale.length > 0) await db.rechecks.bulkDelete(stale.map((d) => d.id));
          await db.recheckState.put({
            plotId,
            status: 'stale',
            invalidatedAt: Date.now(),
            reason: `样木编号校正（组 ${group.canonicalTreeNo}）`,
          });
        },
      );
    } catch (e) {
      // 事务已回滚：样木档案恢复原样；草稿独立落库未受影响，保留待修正
      return {
        ok: false,
        error: e instanceof Error ? e.message : '校正事务失败，已恢复原档案',
      };
    }

    const confirmed: TreeGroup = {
      ...group,
      status: 'confirmed',
      confirmedAt: Date.now(),
    };
    set({
      groups: [confirmed, ...get().groups.filter((g) => g.id !== group.id)],
    });
    return { ok: true };
  },
}));
