import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { TreeRecord } from '../types/tree';
import type { RegenShrub } from '../types/regen';
import type { RecheckDiff } from '../types/recheck';
import { newId } from './id';

export const DB_NAME = 'gbforestplot';
export const DB_VERSION = 3;
export const LS_VERSION_KEY = 'gbforestplot:db-version';

class ForestPlotDB extends Dexie {
  plots!: Table<Plot, string>;
  trees!: Table<TreeRecord, string>;
  regens!: Table<RegenShrub, string>;
  rechecks!: Table<RecheckDiff, string>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      plots: 'id, plotNo, locality, forestType, surveyRound, createdAt',
      trees: 'id, plotId, treeNo, species, round, status',
      regens: 'id, plotId, layer, species, round',
      rechecks: 'id, plotId, baseRound, targetRound, treeNo',
    });
    this.version(2)
      .stores({
        plots: 'id, plotNo, locality, forestType, surveyRound, locked, createdAt',
        trees: 'id, plotId, treeNo, species, round, status, measuredAt',
        regens: 'id, plotId, layer, species, round, heightCm',
        rechecks: 'id, plotId, baseRound, targetRound, treeNo, generatedAt',
      })
      .upgrade(async (tx) => {
        await tx
          .table('plots')
          .toCollection()
          .modify((row: any) => {
            if (row.locked === undefined) row.locked = false;
            if (row.surveyRound === undefined) row.surveyRound = 1;
          });
        await tx
          .table('trees')
          .toCollection()
          .modify((row: any) => {
            if (row.round === undefined) row.round = 1;
            if (row.measuredAt === undefined) row.measuredAt = Date.now();
          });
      });
    // v3：复查结果增加 stale 索引（编号校正后引用旧树号的比对立即失效，待重算）
    this.version(3).stores({
      plots: 'id, plotNo, locality, forestType, surveyRound, locked, createdAt',
      trees: 'id, plotId, treeNo, species, round, status, measuredAt',
      regens: 'id, plotId, layer, species, round, heightCm',
      rechecks: 'id, plotId, baseRound, targetRound, treeNo, generatedAt, stale',
    });
  }
}

export const db = new ForestPlotDB();

export function markDbVersion(): void {
  try {
    window.localStorage.setItem(LS_VERSION_KEY, String(DB_VERSION));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function readDbVersion(): number {
  try {
    const raw = window.localStorage.getItem(LS_VERSION_KEY);
    return raw ? Number(raw) : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

export async function saveRecheckDiffs(diffs: RecheckDiff[]): Promise<void> {
  await db.rechecks.bulkPut(diffs);
}

/**
 * 保存一次两期比对：先清掉该样地同两期的旧比对（含已失效旧值），
 * 再整批写入新结果。用于编号校正后重算，避免旧树号差值残留。
 */
export async function replaceRecheckDiffs(
  plotId: string,
  baseRound: number,
  targetRound: number,
  diffs: RecheckDiff[],
): Promise<void> {
  await db.transaction('rw', db.rechecks, async () => {
    const stale = await db.rechecks
      .where('plotId')
      .equals(plotId)
      .filter((d) => d.baseRound === baseRound && d.targetRound === targetRound)
      .primaryKeys();
    await db.rechecks.bulkDelete(stale);
    await db.rechecks.bulkPut(diffs);
  });
}

/** 该样地是否存在已失效、待重算的复查结果 */
export async function loadStaleRechecks(plotId: string): Promise<RecheckDiff[]> {
  return db.rechecks
    .where('plotId')
    .equals(plotId)
    .filter((d) => d.stale === true)
    .toArray();
}

export async function loadRecheckDiffs(plotId: string): Promise<RecheckDiff[]> {
  const rows = await db.rechecks.where('plotId').equals(plotId).toArray();
  return rows.sort(
    (a, b) =>
      Number(a.stale === true) - Number(b.stale === true) ||
      a.baseRound - b.baseRound ||
      a.targetRound - b.targetRound ||
      a.treeNo.localeCompare(b.treeNo, 'zh-Hans-CN', { numeric: true }),
  );
}

/** 首次进入灌入示范样地与两期样木数据 */
export async function ensureSeedData(): Promise<void> {
  const count = await db.plots.count();
  if (count > 0) return;

  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const plotId = newId('plot');
  const plot2Id = newId('plot');

  const plots: Plot[] = [
    {
      id: plotId,
      plotNo: 'FP-4102',
      locality: '黑龙江凉水林场 12 林班',
      lng: 128.8934,
      lat: 47.1832,
      shape: '方形',
      area: 600,
      elevation: 412,
      slope: 8,
      aspect: '东南',
      forestType: '针阔混交林',
      canopyDensity: 0.72,
      dominantSpecies: '红松 + 紫椴',
      surveyRound: 3,
      surveyedAt: now - 1 * day,
      crew: '调查一组（顾青、李慕）',
      locked: true,
      createdAt: now - 400 * day,
    },
    {
      id: plot2Id,
      plotNo: 'FP-4115',
      locality: '黑龙江凉水林场 15 林班',
      lng: 128.9012,
      lat: 47.1901,
      shape: '圆形',
      area: 500,
      elevation: 388,
      slope: 14,
      aspect: '西南',
      forestType: '阔叶林',
      canopyDensity: 0.65,
      dominantSpecies: '蒙古栎',
      surveyRound: 1,
      surveyedAt: now - 3 * day,
      crew: '调查二组（周砚）',
      locked: false,
      createdAt: now - 120 * day,
    },
  ];

  type Seed = [string, string, number, number, number, number, TreeRecord['status']];
  const seeds: Seed[] = [
    ['1', '红松', 34.2, 18.6, 7.4, 5.2, '活立木'],
    ['2', '紫椴', 26.8, 15.2, 5.1, 4.4, '活立木'],
    ['3', '红松', 41.5, 21.3, 9.2, 6.1, '活立木'],
    ['4', '蒙古栎', 18.4, 11.5, 3.6, 3.2, '活立木'],
    ['5', '色木槭', 12.6, 9.4, 2.8, 2.6, '活立木'],
  ];

  const trees: TreeRecord[] = [];
  seeds.forEach(([treeNo, species, dbh, h, ubh, cw, status]) => {
    trees.push({
      id: newId('tree'),
      plotId,
      treeNo,
      species,
      dbhCm: dbh,
      heightM: h,
      underBranchH: ubh,
      crownWidth: cw,
      status,
      origin: '天然',
      healthClass: '健康',
      tiltDeg: 2,
      remark: `样地中部 ${treeNo} 号桩`,
      round: 1,
      measuredAt: now - 370 * day,
    });
  });
  // 第 2 期：树号 1/2/3/5 复测（胸径增大），树号 4 被采伐 → 复查比对可标记缺失
  seeds.forEach(([treeNo, species, dbh, h, ubh, cw], index) => {
    if (treeNo === '4') return;
    const growth = [1.8, 1.4, 2.2, 0.9][index > 3 ? 3 : index];
    trees.push({
      id: newId('tree'),
      plotId,
      treeNo,
      species,
      dbhCm: Math.round((dbh + growth) * 10) / 10,
      heightM: Math.round((h + growth * 0.6) * 10) / 10,
      underBranchH: ubh,
      crownWidth: cw,
      status: '活立木',
      origin: '天然',
      healthClass: '健康',
      tiltDeg: 2,
      remark: `样地中部 ${treeNo} 号桩`,
      round: 2,
      measuredAt: now - 6 * day,
    });
  });
  // 第 2 期新增进界木
  trees.push({
    id: newId('tree'),
    plotId,
    treeNo: '6',
    species: '色木槭',
    dbhCm: 6.2,
    heightM: 6.1,
    underBranchH: 1.8,
    crownWidth: 1.9,
    status: '活立木',
    origin: '天然',
    healthClass: '健康',
    tiltDeg: 1,
    remark: '样地东南 3m 进界木',
    round: 2,
    measuredAt: now - 6 * day,
  });
  // 早期编号串号示范：7 号把两株并成一条（第 1 期红松/西北，第 2 期误写成白桦/东北），
  // 复查硬配时胸径与树高生长量跨株；另一条第 1 期白桦被错编为 10 号。
  trees.push(
    {
      id: newId('tree'),
      plotId,
      treeNo: '7',
      species: '红松',
      dbhCm: 15.2,
      heightM: 10.4,
      underBranchH: 3.1,
      crownWidth: 2.6,
      status: '活立木',
      origin: '天然',
      healthClass: '健康',
      tiltDeg: 2,
      remark: '样地西北 6m',
      round: 1,
      measuredAt: now - 370 * day,
    },
    {
      id: newId('tree'),
      plotId,
      treeNo: '7',
      species: '白桦',
      dbhCm: 9.8,
      heightM: 8.2,
      underBranchH: 3.4,
      crownWidth: 2.1,
      status: '活立木',
      origin: '天然',
      healthClass: '健康',
      tiltDeg: 3,
      remark: '样地东北 4m',
      round: 2,
      measuredAt: now - 6 * day,
    },
    {
      id: newId('tree'),
      plotId,
      treeNo: '10',
      species: '白桦',
      dbhCm: 8.9,
      heightM: 7.6,
      underBranchH: 3.2,
      crownWidth: 1.8,
      status: '活立木',
      origin: '天然',
      healthClass: '健康',
      tiltDeg: 3,
      remark: '样地东北 4m',
      round: 1,
      measuredAt: now - 370 * day,
    },
  );
  // 8 号：第 1 期有测、第 2 期缺测、第 3 期又出现 —— 跨缺测期重现，校正时须核对号牌逐条确认。
  // 第 3 期复测（含 8 号重现）：第 2 期被采伐的 4 号仍缺。
  const round3: Seed[] = [
    ['1', '红松', 37.6, 20.4, 7.4, 5.2, '活立木'],
    ['2', '紫椴', 29.4, 16.8, 5.1, 4.4, '活立木'],
    ['3', '红松', 45.6, 23.2, 9.2, 6.1, '活立木'],
    ['5', '色木槭', 14.2, 10.6, 2.8, 2.6, '活立木'],
    ['6', '色木槭', 7.4, 6.9, 1.8, 1.9, '活立木'],
    ['8', '水曲柳', 11.1, 9.2, 3.0, 2.2, '活立木'],
  ];
  round3.forEach(([treeNo, species, dbh, h, ubh, cw, status]) => {
    trees.push({
      id: newId('tree'),
      plotId,
      treeNo,
      species,
      dbhCm: dbh,
      heightM: h,
      underBranchH: ubh,
      crownWidth: cw,
      status,
      origin: '天然',
      healthClass: '健康',
      tiltDeg: 2,
      remark: treeNo === '8' ? '样地北缘 8m 桩' : `样地中部 ${treeNo} 号桩`,
      round: 3,
      measuredAt: now - 1 * day,
    });
  });
  trees.push({
    id: newId('tree'),
    plotId,
    treeNo: '8',
    species: '水曲柳',
    dbhCm: 9.6,
    heightM: 8.4,
    underBranchH: 2.9,
    crownWidth: 2.0,
    status: '活立木',
    origin: '天然',
    healthClass: '健康',
    tiltDeg: 2,
    remark: '样地北缘 8m 桩',
    round: 1,
    measuredAt: now - 370 * day,
  });
  // 第 3 期期内重复示范：11 号被录了两条（一条是误录的进界木），复查页应硬拦截。
  trees.push(
    {
      id: newId('tree'),
      plotId,
      treeNo: '11',
      species: '云杉',
      dbhCm: 5.4,
      heightM: 4.6,
      underBranchH: 1.2,
      crownWidth: 1.4,
      status: '活立木',
      origin: '天然',
      healthClass: '健康',
      tiltDeg: 1,
      remark: '样地西 2m 进界木',
      round: 3,
      measuredAt: now - 1 * day,
    },
    {
      id: newId('tree'),
      plotId,
      treeNo: '11',
      species: '云杉',
      dbhCm: 5.5,
      heightM: 4.7,
      underBranchH: 1.2,
      crownWidth: 1.4,
      status: '活立木',
      origin: '天然',
      healthClass: '健康',
      tiltDeg: 1,
      remark: '样地西 2m 进界木（重复误录）',
      round: 3,
      measuredAt: now - 1 * day,
    },
  );
  trees.push({
    id: newId('tree'),
    plotId: plot2Id,
    treeNo: '1',
    species: '蒙古栎',
    dbhCm: 22.4,
    heightM: 13.2,
    underBranchH: 4.2,
    crownWidth: 4.1,
    status: '活立木',
    origin: '天然',
    healthClass: '亚健康',
    tiltDeg: 6,
    remark: '样地西侧',
    round: 1,
    measuredAt: now - 3 * day,
  });

  const regens: RegenShrub[] = [
    {
      id: newId('regen'),
      plotId,
      layer: '更新苗',
      species: '红松',
      heightCm: 32,
      count: 18,
      ageGroup: '3 年生',
      distribution: '团状',
      browseDamage: '轻度',
      round: 2,
    },
    {
      id: newId('regen'),
      plotId,
      layer: '更新苗',
      species: '紫椴',
      heightCm: 55,
      count: 9,
      ageGroup: '多年生',
      distribution: '均匀',
      browseDamage: '无',
      round: 2,
    },
    {
      id: newId('regen'),
      plotId,
      layer: '灌木',
      species: '毛榛子',
      heightCm: 120,
      count: 26,
      ageGroup: '多年生',
      distribution: '团状',
      browseDamage: '中度',
      round: 2,
    },
    {
      id: newId('regen'),
      plotId,
      layer: '草本',
      species: '苔草',
      heightCm: 22,
      count: 140,
      ageGroup: '多年生',
      distribution: '均匀',
      browseDamage: '无',
      round: 2,
    },
  ];
  regens.forEach((r) => {
    r.round = 3;
  });

  await db.transaction('rw', db.plots, db.trees, db.regens, db.rechecks, async () => {
    await db.plots.bulkPut(plots);
    await db.trees.bulkPut(trees);
    await db.regens.bulkPut(regens);
  });
}
