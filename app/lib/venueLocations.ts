export type Floor = 1 | 2 | 3;
export type MapRegion = {
  id: string;
  floor: Floor;
  label: string;
  kind: 'room' | 'hall' | 'service' | 'entry';
  x: number;
  y: number;
  note: string;
};
export type VenueLocation = {
  id: string;
  floor: Floor;
  label: string;
  sourceLocation: string;
  regionId: string | null;
  status: 'exact' | 'area' | 'unresolved';
  note: string;
};

export const MAP_FLOORS: readonly { id: Floor; label: string; imagePath: string; width: number; height: number }[] = [
  { id: 1, label: '一层', imagePath: '/venue/1F.jpg', width: 2134, height: 1224 },
  { id: 2, label: '二层', imagePath: '/venue/2F.jpg', width: 1162, height: 554 },
  { id: 3, label: '三层', imagePath: '/venue/3F.jpg', width: 1162, height: 534 },
];

// Percent coordinates mark approximate areas on the supplied images, not surveyed room bounds.
// Image event-specific annotations are retained as source material, not adopted as this year's assignments.
export const MAP_REGIONS: readonly MapRegion[] = [
  { id:'f1-101', floor:1, label:'101 区域', kind:'room', x:42.5, y:36.7, note:'原图分为 101A、101B；本届日程仅写 101，显示整个编号会场区域，不指定分隔。' },
  { id:'f1-102', floor:1, label:'102 区域', kind:'room', x:81.4, y:37.0, note:'原图分为 102A、102B；本届日程仅写 102，显示整个编号会场区域，不指定分隔。' },
  { id:'f1-103', floor:1, label:'103 区域', kind:'room', x:85.1, y:56.0, note:'原图标有分会场 103A 和试片室 103B；本届日程仅写 103，具体使用分区请现场核对。' },
  { id:'f1-104', floor:1, label:'104', kind:'room', x:41.4, y:57.1, note:'原图和本届日程均标为一层 104。' },
  { id:'f1-exhibition-3', floor:1, label:'3号展厅（原图）', kind:'hall', x:12.6, y:27.7, note:'原图把 3 号展厅标为主会场，但本届 Excel 主会场为二层多功能厅；两者不作对应。' },
  { id:'f1-medical', floor:1, label:'医务室（原图）', kind:'service', x:52.1, y:34.3, note:'原图标注 VIP1-1 医疗室；本届是否沿用请以现场指示为准。' },
  { id:'f1-exhibits', floor:1, label:'展区（原图）', kind:'service', x:61.7, y:45.6, note:'原图标注标展展区、特装展区；不代表本届展位安排。' },
  { id:'f1-registration', floor:1, label:'注册区（原图）', kind:'service', x:70.7, y:67.9, note:'原图注册区位置；本届报到安排以大会现场通知为准。' },
  { id:'f1-self-registration', floor:1, label:'自助注册（原图）', kind:'service', x:57.5, y:69.0, note:'原图自助注册区位置；本届是否沿用请现场核对。' },
  { id:'f1-entrance', floor:1, label:'主入口（原图）', kind:'entry', x:65.1, y:87.9, note:'原图主入口及箭头为原图标示，不代表实时通行路线、用户位置或本届推荐路线。' },
  { id:'f2-201', floor:2, label:'201 区域', kind:'room', x:35.0, y:26.2, note:'原图只标 201；日程中的 201A、201B 共用该区域定位，未猜测 A/B 的左右分隔。' },
  { id:'f2-203', floor:2, label:'203 区域', kind:'room', x:83.3, y:56.0, note:'原图只标 203；日程 203B 定位至编号区域，B 分区位置请现场核对。' },
  { id:'f2-204', floor:2, label:'204 区域', kind:'room', x:30.4, y:56.0, note:'原图只标 204；日程中的 204A、204B 共用该区域定位，未猜测 A/B 分隔。' },
  { id:'f2-hall-b', floor:2, label:'多功能厅B（原图）', kind:'hall', x:58.0, y:42.2, note:'原图标注二层多功能厅 B；不能与日程的一层多功能厅 B 混用，也未确认其为本届主会场。' },
  { id:'f2-hall-c', floor:2, label:'多功能厅C（原图）', kind:'hall', x:53.9, y:25.6, note:'原图标注多功能厅 C；日程中的二层多功能厅 A 未在原图明确出现，不能据此替代。' },
  { id:'f2-hall-d', floor:2, label:'多功能厅D（原图）', kind:'hall', x:62.3, y:25.6, note:'原图标注多功能厅 D；本届对应关系未明确，不关联其他厅的报告。' },
  { id:'f2-vip', floor:2, label:'202 VIP（原图）', kind:'service', x:80.6, y:26.4, note:'原图标注 VIP 用餐区 202；本届用途以现场通知为准。' },
  { id:'f2-posters', floor:2, label:'电子壁报（原图）', kind:'service', x:58.4, y:66.4, note:'原图电子壁报区；本届是否沿用请现场核对。' },
  { id:'f3-301', floor:3, label:'301 区域', kind:'room', x:33.6, y:27.2, note:'原图只标 301；日程 301A、301B 共用该区域定位，未猜测 A/B 分隔。' },
  { id:'f3-302', floor:3, label:'302 区域', kind:'room', x:79.3, y:27.0, note:'原图只标 302；日程 302A、302B 共用该区域定位，未猜测 A/B 分隔。' },
  { id:'f3-303', floor:3, label:'303 区域', kind:'room', x:82.3, y:58.1, note:'原图只标 303；日程 303A、303B 共用该区域定位，未猜测 A/B 分隔。' },
  { id:'f3-304', floor:3, label:'304 区域', kind:'room', x:30.5, y:58.1, note:'原图只标 304；日程 304A、304B 共用该区域定位，未猜测 A/B 分隔。' },
  { id:'f3-dining', floor:3, label:'多功能厅（原图用餐区）', kind:'service', x:56.2, y:32.8, note:'原图标注三层代表用餐区；不作为本届报告会场，也不推断本届用餐安排。' },
];

export const VENUES: readonly VenueLocation[] = [
  { id:'main', floor:2, label:'主会场 · 二层多功能厅', sourceLocation:'主会场（二层多功能厅）', regionId:null, status:'unresolved', note:'位置待核对：日程写二层多功能厅，原图却将一层 3 号展厅标为主会场。按日程显示二层，不把报告指向一层展厅或二层 B/C/D 厅。' },
  { id:'v01', floor:2, label:'第一分会场 · 多功能厅A', sourceLocation:'第一分会场（二层多功能厅A）', regionId:null, status:'unresolved', note:'位置待核对：日程写二层多功能厅 A，原图二层标有 B/C/D，未明确 A 的位置。' },
  { id:'v02', floor:1, label:'第二分会场 · 多功能厅B', sourceLocation:'第二分会场（一层多功能厅B）', regionId:null, status:'unresolved', note:'位置待核对：日程写一层多功能厅 B，原图一层未标此厅；二层 B 厅不作跨楼层替代。' },
  { id:'v03', floor:1, label:'第三分会场 · 101', sourceLocation:'第三分会场（一层101）', regionId:'f1-101', status:'area', note:'定位至 101 区域；原图有 A/B 分隔，本届具体使用范围请现场核对。' },
  { id:'v04', floor:1, label:'第四分会场 · 102', sourceLocation:'第四分会场（一层102）', regionId:'f1-102', status:'area', note:'定位至 102 区域；原图有 A/B 分隔，本届具体使用范围请现场核对。' },
  { id:'v05', floor:1, label:'第五分会场 · 103', sourceLocation:'第五分会场（一层103）', regionId:'f1-103', status:'area', note:'定位至 103 区域；原图 103B 是试片室，不能直接推断为本届报告分区。' },
  { id:'v06', floor:1, label:'第六分会场 · 104', sourceLocation:'第六分会场（一层104）', regionId:'f1-104', status:'exact', note:'楼层和房间编号与原图一致；标记为图上示意点，不代表真实门位。' },
  { id:'v07', floor:2, label:'第七分会场 · 201A', sourceLocation:'第七分会场（二层201A）', regionId:'f2-201', status:'area', note:'定位至 201 区域，A 分区未在原图单独标出。' },
  { id:'v08', floor:2, label:'第八分会场 · 201B', sourceLocation:'第八分会场（二层201B）', regionId:'f2-201', status:'area', note:'定位至 201 区域，B 分区未在原图单独标出。' },
  { id:'v09', floor:2, label:'第九分会场 · 203B', sourceLocation:'第九分会场（二层203B）', regionId:'f2-203', status:'area', note:'定位至 203 区域，B 分区未在原图单独标出。' },
  { id:'v10', floor:2, label:'第十分会场 · 204A', sourceLocation:'第十分会场（二层204A）', regionId:'f2-204', status:'area', note:'定位至 204 区域，A 分区未在原图单独标出。' },
  { id:'v11', floor:2, label:'第十一分会场 · 204B', sourceLocation:'第十一分会场（二层204B）', regionId:'f2-204', status:'area', note:'定位至 204 区域，B 分区未在原图单独标出。' },
  { id:'v12', floor:3, label:'第十二分会场 · 301A', sourceLocation:'第十二分会场（三层301A）', regionId:'f3-301', status:'area', note:'定位至 301 区域，A 分区未在原图单独标出。' },
  { id:'v13', floor:3, label:'第十三分会场 · 301B', sourceLocation:'第十三分会场（三层301B）', regionId:'f3-301', status:'area', note:'定位至 301 区域，B 分区未在原图单独标出。' },
  { id:'v14', floor:3, label:'第十四分会场 · 302A', sourceLocation:'第十四分会场（三层302A）', regionId:'f3-302', status:'area', note:'定位至 302 区域，A 分区未在原图单独标出。' },
  { id:'v15', floor:3, label:'第十五分会场 · 302B', sourceLocation:'第十五分会场（三层302B）', regionId:'f3-302', status:'area', note:'定位至 302 区域，B 分区未在原图单独标出。' },
  { id:'v16', floor:3, label:'第十六分会场 · 303A', sourceLocation:'第十六分会场（三层303A）', regionId:'f3-303', status:'area', note:'定位至 303 区域，A 分区未在原图单独标出。' },
  { id:'v17', floor:3, label:'第十七分会场 · 303B', sourceLocation:'第十七分会场（三层303B）', regionId:'f3-303', status:'area', note:'定位至 303 区域，B 分区未在原图单独标出。' },
  { id:'v18', floor:3, label:'第十八分会场 · 304A', sourceLocation:'第十八分会场（三层304A）', regionId:'f3-304', status:'area', note:'定位至 304 区域，A 分区未在原图单独标出。' },
  { id:'v19', floor:3, label:'第十九分会场 · 304B', sourceLocation:'第十九分会场（三层304B）', regionId:'f3-304', status:'area', note:'定位至 304 区域，B 分区未在原图单独标出。' },
];

export const REGION_BY_ID: Readonly<Partial<Record<string, MapRegion>>> = Object.fromEntries(MAP_REGIONS.map(region => [region.id, region]));
export const VENUE_BY_LOCATION: Readonly<Partial<Record<string, VenueLocation>>> = Object.fromEntries(VENUES.map(venue => [venue.sourceLocation, venue]));
