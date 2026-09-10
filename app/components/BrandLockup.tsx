import { publicPath } from '../lib/sitePaths';

export const BRAND_SLOGAN_CN = '汇聚真知，传播有度';
export const BRAND_SLOGAN_EN = 'Where Knowledge Converges, Communication Finds Its Measure.';

export function BrandLogo({ compact=false }:{ compact?:boolean }) {
  return <span className={`huiduBrand ${compact?'isCompact':''}`}>
    <img src={publicPath('/huidu-logo.png')} alt="汇度 HUIDU" />
  </span>;
}

export function BrandLockup({ compact=false, inverse=false }:{ compact?:boolean; inverse?:boolean }) {
  return <div className={`huiduLockup ${compact?'isCompact':''} ${inverse?'isInverse':''}`}>
    <BrandLogo compact={compact}/>
    <span className="huiduDivider" aria-hidden="true" />
    <span className="huiduSlogan"><b>神经病学年会</b>{!compact&&<small>CMANCN 2026 · {BRAND_SLOGAN_CN}</small>}</span>
  </div>;
}

export function HuiduQrCallout({ compact=false }:{ compact?:boolean }) {
  return <div className={`huiduQrCallout ${compact?'isCompact':''}`}>
    <img src={publicPath('/huidu-latest-qr.jpg')} alt="汇度最新信息二维码" />
    <span>
      <b>扫码获取最新信息</b>
      <small>关注医界望远镜 · 持续获取专业内容</small>
    </span>
  </div>;
}
