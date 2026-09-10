import { deferred } from './deferred';

export type SlidePoint = { x:number; y:number };
export type SlideCorners = [SlidePoint,SlidePoint,SlidePoint,SlidePoint];

const MAX_BYTES=40*1024*1024;
const MAX_PIXELS=48_000_000;
const MAX_EDGE=2400;
const THUMB_EDGE=400;
function pause() {
  const {promise,resolve}=deferred<void>();
  setTimeout(resolve,0);
  return promise;
}

type DecodedImage={source:CanvasImageSource;width:number;height:number;close:()=>void};

function checkDimensions(width:number,height:number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width<1 || height<1) throw new Error('图片没有有效的尺寸。');
  if (width*height>MAX_PIXELS || Math.max(width,height)>16384) throw new Error('图片超过 4800 万像素或单边 16384 像素，请先缩小图片后重试。');
}

async function checkHeaderDimensions(blob:Blob) {
  // Read only headers before decoding common compressed formats, avoiding oversized raster allocation.
  const buffer=await blob.slice(0,1024*1024).arrayBuffer();
  const bytes=new Uint8Array(buffer),view=new DataView(buffer);
  if (bytes.length<10) return;
  if (bytes.length>=24 && view.getUint32(0)===0x89504e47 && view.getUint32(4)===0x0d0a1a0a) {
    checkDimensions(view.getUint32(16),view.getUint32(20));
  } else if (bytes[0]===0xff && bytes[1]===0xd8) {
    let offset=2;
    while (offset+4<=bytes.length) {
      if (bytes[offset++]!==0xff) break;
      while (offset<bytes.length && bytes[offset]===0xff) offset++;
      if (offset>=bytes.length) break;
      const marker=bytes[offset++];
      if (marker===0xda || marker===0xd9) break;
      if (marker===0x01 || (marker>=0xd0 && marker<=0xd8)) continue;
      if (offset+2>bytes.length) break;
      const length=view.getUint16(offset);
      if (length<2 || offset+length>bytes.length) break;
      if (marker>=0xc0 && marker<=0xcf && marker!==0xc4 && marker!==0xc8 && marker!==0xcc && length>=7) {
        checkDimensions(view.getUint16(offset+5),view.getUint16(offset+3));
        return;
      }
      offset+=length;
    }
  } else if (bytes[0]===0x47 && bytes[1]===0x49 && bytes[2]===0x46) {
    checkDimensions(view.getUint16(6,true),view.getUint16(8,true));
  } else if (bytes.length>=30 && view.getUint32(0)===0x52494646 && view.getUint32(8)===0x57454250) {
    const kind=view.getUint32(12);
    if (kind===0x56503858) {
      checkDimensions(1+bytes[24]+bytes[25]*256+bytes[26]*65536,1+bytes[27]+bytes[28]*256+bytes[29]*65536);
    } else if (kind===0x5650384c && bytes[20]===0x2f) {
      checkDimensions(1+((bytes[22]&0x3f)<<8)+bytes[21],1+((bytes[24]&0x0f)<<10)+(bytes[23]<<2)+(bytes[22]>>6));
    } else if (kind===0x56503820 && bytes[23]===0x9d && bytes[24]===0x01 && bytes[25]===0x2a) {
      checkDimensions(view.getUint16(26,true)&0x3fff,view.getUint16(28,true)&0x3fff);
    }
  }
}

async function decode(blob:Blob):Promise<DecodedImage> {
  if (!blob.size) throw new Error('图片文件为空。');
  if (blob.size>MAX_BYTES) throw new Error('单张图片不能超过 40 MB，请先缩小图片后重试。');
  await checkHeaderDimensions(blob);
  if (typeof createImageBitmap==='function') {
    let bitmap:ImageBitmap|undefined;
    try { bitmap=await createImageBitmap(blob,{imageOrientation:'from-image'}); } catch { /* Some browsers only decode a format through HTMLImageElement. */ }
    if (bitmap) {
      try { checkDimensions(bitmap.width,bitmap.height); }
      catch (error) { bitmap.close(); throw error; }
      return {source:bitmap,width:bitmap.width,height:bitmap.height,close:()=>bitmap.close()};
    }
  }
  const url=URL.createObjectURL(blob);
  const image=new Image();
  image.decoding='async';
  try {
    const {promise,resolve,reject}=deferred<void>();
    image.onload=()=>resolve();
    image.onerror=()=>reject(new Error('浏览器无法解码这张图片。请使用 JPEG、PNG、WebP 等支持的格式；HEIC/HEIF 仅在浏览器原生支持时可用。'));
    image.src=url;
    await promise;
    checkDimensions(image.naturalWidth,image.naturalHeight);
    return {source:image,width:image.naturalWidth,height:image.naturalHeight,close:()=>{ image.src=''; URL.revokeObjectURL(url); }};
  } catch (error) {
    image.src='';
    URL.revokeObjectURL(url);
    throw error;
  } finally {
    image.onload=null;
    image.onerror=null;
  }
}

function canvas(width:number,height:number) {
  const value=document.createElement('canvas');
  value.width=Math.max(1,Math.round(width));
  value.height=Math.max(1,Math.round(height));
  return value;
}

function context(value:HTMLCanvasElement,read=false) {
  const ctx=value.getContext('2d',{willReadFrequently:read});
  if (!ctx) throw new Error('当前浏览器无法创建图片处理画布。');
  return ctx;
}

function release(value:HTMLCanvasElement) { value.width=1; value.height=1; }

function fitted(width:number,height:number,edge:number) {
  const scale=Math.min(1,edge/Math.max(width,height));
  return {width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale))};
}

function draw(source:CanvasImageSource,width:number,height:number,edge:number) {
  const size=fitted(width,height,edge);
  const value=canvas(size.width,size.height);
  const ctx=context(value);
  ctx.fillStyle='#ffffff';
  ctx.fillRect(0,0,value.width,value.height);
  ctx.imageSmoothingEnabled=true;
  ctx.imageSmoothingQuality='high';
  ctx.drawImage(source,0,0,value.width,value.height);
  return value;
}

function encode(value:HTMLCanvasElement,type='image/jpeg',quality=0.91):Promise<Blob> {
  const {promise,resolve,reject}=deferred<Blob>();
  value.toBlob((blob)=>blob ? resolve(blob) : reject(new Error('图片编码失败，请关闭其他页面释放内存后重试。')),type,quality);
  return promise;
}

async function thumbnail(source:CanvasImageSource,width:number,height:number) {
  const value=draw(source,width,height,THUMB_EDGE);
  try { return await encode(value,'image/jpeg',0.8); } finally { release(value); }
}

export async function prepareSlideImage(file:File):Promise<{original:Blob;thumbnail:Blob;width:number;height:number}> {
  const image=await decode(file);
  try {
    return {original:file,thumbnail:await thumbnail(image.source,image.width,image.height),width:image.width,height:image.height};
  } finally { image.close(); }
}

function cross(a:SlidePoint,b:SlidePoint,c:SlidePoint) {
  return (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
}

function area(points:SlidePoint[]) {
  let sum=0;
  for (let i=0;i<points.length;i++) {
    const a=points[i],b=points[(i+1)%points.length];
    sum+=a.x*b.y-b.x*a.y;
  }
  return sum/2;
}

function validateCorners(corners:SlideCorners,minArea=0.015) {
  if (corners.length!==4 || corners.some((p)=>!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x<0 || p.x>1 || p.y<0 || p.y>1)) throw new Error('四个角点必须位于图片内。');
  if (area(corners)<minArea || corners.some((p,i)=>cross(p,corners[(i+1)%4],corners[(i+2)%4])<=0.0001)) throw new Error('请按左上、右上、右下、左下顺序选择四角，避免交叉、共线或过小的区域。');
}

function convexHull(points:SlidePoint[]) {
  points.sort((a,b)=>a.x-b.x || a.y-b.y);
  const lower:SlidePoint[]=[],upper:SlidePoint[]=[];
  for (const p of points) {
    while (lower.length>=2 && cross(lower[lower.length-2],lower[lower.length-1],p)<=0) lower.pop();
    lower.push(p);
  }
  for (let i=points.length-1;i>=0;i--) {
    const p=points[i];
    while (upper.length>=2 && cross(upper[upper.length-2],upper[upper.length-1],p)<=0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

function quadrilateral(points:SlidePoint[]):SlideCorners|null {
  const hull=convexHull(points);
  const hullArea=area(hull);
  if (hull.length<4 || hullArea<=0) return null;
  while (hull.length>4) {
    let smallest=Infinity,index=0;
    for (let i=0;i<hull.length;i++) {
      const loss=Math.abs(cross(hull[(i+hull.length-1)%hull.length],hull[i],hull[(i+1)%hull.length]));
      if (loss<smallest) { smallest=loss; index=i; }
    }
    hull.splice(index,1);
  }
  if (area(hull)/hullArea<0.88) return null;
  let start=0;
  for (let i=1;i<4;i++) if (hull[i].x+hull[i].y<hull[start].x+hull[start].y) start=i;
  return [hull[start],hull[(start+1)%4],hull[(start+2)%4],hull[(start+3)%4]];
}

/** Bright connected region + convex hull approximation; uncertain scenes need manual corners. */
export async function detectSlideCorners(original:Blob):Promise<SlideCorners|null> {
  const image=await decode(original);
  let value:HTMLCanvasElement;
  try { value=draw(image.source,image.width,image.height,320); } finally { image.close(); }
  try {
    const width=value.width,height=value.height;
    if (width<32 || height<32) return null;
    const pixels=context(value,true).getImageData(0,0,width,height).data;
    const luminance=new Uint8Array(width*height);
    const histogram=new Uint32Array(256);
    for (let i=0;i<luminance.length;i++) {
      const p=i*4;
      luminance[i]=Math.round(pixels[p]*0.2126+pixels[p+1]*0.7152+pixels[p+2]*0.0722);
      histogram[luminance[i]]++;
    }
    let sum=0,percentile=180;
    for (let i=0;i<256;i++) { sum+=histogram[i]; if (sum>=luminance.length*0.65) { percentile=i; break; } }
    const thresholds=Array.from(new Set([150,185,215,Math.max(135,Math.min(230,percentile-12))]));
    const seen=new Uint8Array(luminance.length);
    const queue=new Int32Array(luminance.length);
    let best:SlideCorners|null=null,bestScore=0;
    for (const threshold of thresholds) {
      seen.fill(0);
      for (let seed=0;seed<luminance.length;seed++) {
        if (seen[seed] || luminance[seed]<threshold) continue;
        let head=0,tail=1;
        queue[0]=seed; seen[seed]=1;
        const boundary:SlidePoint[]=[];
        while (head<tail) {
          const index=queue[head++],x=index%width,y=Math.floor(index/width);
          let edge=x===0 || y===0 || x===width-1 || y===height-1;
          for (let direction=0;direction<4;direction++) {
            if ((direction===0 && x===0) || (direction===1 && x===width-1) || (direction===2 && y===0) || (direction===3 && y===height-1)) continue;
            const next=index+(direction===0 ? -1 : direction===1 ? 1 : direction===2 ? -width : width);
            if (luminance[next]<threshold) { edge=true; continue; }
            if (!seen[next]) { seen[next]=1; queue[tail++]=next; }
          }
          if (edge) boundary.push({x,y});
        }
        if (tail<luminance.length*0.1) continue;
        const quad=quadrilateral(boundary);
        if (!quad) continue;
        const normalized=quad.map((p)=>({x:p.x/(width-1),y:p.y/(height-1)})) as SlideCorners;
        try { validateCorners(normalized,0.12); } catch { continue; }
        const quadArea=area(quad),coverage=tail/quadArea;
        if (coverage<0.55 || coverage>1.18) continue;
        let inside=0,outside=0,insideCount=0,outsideCount=0;
        for (let y=1;y<height-1;y+=3) for (let x=1;x<width-1;x+=3) {
          const p={x,y};
          const within=quad.every((a,i)=>cross(a,quad[(i+1)%4],p)>=0);
          if (within) { inside+=luminance[y*width+x]; insideCount++; }
          else { outside+=luminance[y*width+x]; outsideCount++; }
        }
        if (!insideCount || outsideCount<width*height/9*0.05) continue;
        const contrast=inside/insideCount-outside/outsideCount;
        if (contrast<18) continue;
        // Reject narrow wedges and implausibly acute corners rather than promising a bad scan.
        if (quad.some((p,i)=> {
          const a=quad[(i+3)%4],b=quad[(i+1)%4];
          const length=Math.hypot(a.x-p.x,a.y-p.y)*Math.hypot(b.x-p.x,b.y-p.y);
          return !length || Math.abs(cross(p,a,b))/length<0.3;
        })) continue;
        const score=quadArea/luminance.length*Math.min(1,coverage)*Math.min(1,contrast/70);
        if (score>bestScore) { bestScore=score; best=normalized; }
      }
      await pause();
    }
    return best;
  } finally { release(value); }
}

/** Map destination unit square to an arbitrary source quadrilateral (projective, not affine). */
function homography(points:SlideCorners) {
  const [a,b,c,d]=points;
  const dx1=b.x-c.x,dx2=d.x-c.x,dx3=a.x-b.x+c.x-d.x;
  const dy1=b.y-c.y,dy2=d.y-c.y,dy3=a.y-b.y+c.y-d.y;
  let g=0,h=0;
  if (Math.abs(dx3)+Math.abs(dy3)>1e-10) {
    const determinant=dx1*dy2-dx2*dy1;
    if (Math.abs(determinant)<1e-10) throw new Error('角点无法构成稳定的透视变换，请重新选择。');
    g=(dx3*dy2-dx2*dy3)/determinant;
    h=(dx1*dy3-dx3*dy1)/determinant;
  }
  if (Math.min(1,1+g,1+h,1+g+h)<1e-6) throw new Error('透视角度过大，请重新选择角点。');
  return [b.x-a.x+g*b.x,d.x-a.x+h*d.x,a.x,b.y-a.y+g*b.y,d.y-a.y+h*d.y,a.y,g,h];
}

async function perspective(source:HTMLCanvasElement,corners:SlideCorners) {
  validateCorners(corners);
  const points=corners.map((p)=>({x:p.x*(source.width-1),y:p.y*(source.height-1)})) as SlideCorners;
  const distance=(a:SlidePoint,b:SlidePoint)=>Math.hypot(a.x-b.x,a.y-b.y);
  const size=fitted((distance(points[0],points[1])+distance(points[3],points[2]))/2,(distance(points[0],points[3])+distance(points[1],points[2]))/2,MAX_EDGE);
  if (Math.min(size.width,size.height)<16) throw new Error('选择的区域太窄或太小，无法生成清晰图片。');
  const transform=homography(points);
  const [a,b,c,d,e,f,g,h]=transform;
  const value=canvas(size.width,size.height);
  try {
    const input=context(source,true).getImageData(0,0,source.width,source.height).data;
    const ctx=context(value),output=ctx.createImageData(value.width,value.height),data=output.data;
    const sourceWidth=source.width,sourceHeight=source.height;
    for (let y=0;y<value.height;y++) {
      const v=y/(value.height-1);
      for (let x=0;x<value.width;x++) {
        const u=x/(value.width-1),denominator=g*u+h*v+1;
        const sx=Math.max(0,Math.min(sourceWidth-1,(a*u+b*v+c)/denominator));
        const sy=Math.max(0,Math.min(sourceHeight-1,(d*u+e*v+f)/denominator));
        const left=Math.floor(sx),top=Math.floor(sy),right=Math.min(sourceWidth-1,left+1),bottom=Math.min(sourceHeight-1,top+1);
        const fx=sx-left,fy=sy-top,index=(y*value.width+x)*4;
        const p00=(top*sourceWidth+left)*4,p10=(top*sourceWidth+right)*4,p01=(bottom*sourceWidth+left)*4,p11=(bottom*sourceWidth+right)*4;
        for (let channel=0;channel<3;channel++) data[index+channel]=(input[p00+channel]*(1-fx)+input[p10+channel]*fx)*(1-fy)+(input[p01+channel]*(1-fx)+input[p11+channel]*fx)*fy;
        data[index+3]=255;
      }
      if (y%32===31) await pause();
    }
    ctx.putImageData(output,0,0);
    return value;
  } catch (error) { release(value); throw error; }
}

async function enhance(value:HTMLCanvasElement) {
  const ctx=context(value,true),image=ctx.getImageData(0,0,value.width,value.height),data=image.data;
  const histogram=new Uint32Array(256);
  let red=0,green=0,blue=0,neutral=0,samples=0;
  for (let i=0;i<data.length;i+=16) {
    const r=data[i],g=data[i+1],b=data[i+2],light=Math.round(0.2126*r+0.7152*g+0.0722*b);
    histogram[light]++; samples++;
    if (light>175 && Math.max(r,g,b)-Math.min(r,g,b)<35) { red+=r; green+=g; blue+=b; neutral++; }
  }
  let cumulative=0,black=0,white=255;
  for (let i=0;i<256;i++) {
    cumulative+=histogram[i];
    if (cumulative<samples*0.01) black=i;
    if (cumulative>=samples*0.98) { white=i; break; }
  }
  black=Math.min(25,black); white=Math.max(210,white);
  const average=(red+green+blue)/3;
  const gain=(channel:number)=>neutral>=samples*0.02 && channel>0 ? Math.max(0.9,Math.min(1.1,average/channel)) : 1;
  const rGain=gain(red),gGain=gain(green),bGain=gain(blue);
  const rowBytes=value.width*4;
  for (let y=0;y<value.height;y++) {
    for (let i=y*rowBytes;i<(y+1)*rowBytes;i+=4) {
      const r=data[i]*rGain,g=data[i+1]*gGain,b=data[i+2]*bGain,light=0.2126*r+0.7152*g+0.0722*b;
      const corrected=Math.max(0,Math.min(255,(light-black)*255/(white-black)));
      // One luminance gain preserves chart hues; correction is deliberately modest.
      const factor=light>0 ? Math.max(0.8,Math.min(1.18,(light*0.45+corrected*0.55)/light)) : 1;
      data[i]=r*factor; data[i+1]=g*factor; data[i+2]=b*factor;
    }
    if (y%64===63) await pause();
  }
  ctx.putImageData(image,0,0);
}

export async function processSlideImage(original:Blob,options:{corners?:SlideCorners;enhance?:boolean;rotation?:0|90|180|270}={}):Promise<{blob:Blob;thumbnail:Blob;width:number;height:number}> {
  if (options.corners) validateCorners(options.corners);
  const rotation=options.rotation ?? 0;
  if (![0,90,180,270].includes(rotation)) throw new Error('旋转角度必须是 0、90、180 或 270 度。');
  const image=await decode(original);
  let value:HTMLCanvasElement;
  try { value=draw(image.source,image.width,image.height,MAX_EDGE); } finally { image.close(); }
  try {
    if (options.corners) {
      const corrected=await perspective(value,options.corners);
      release(value); value=corrected;
    }
    if (options.enhance) await enhance(value);
    if (rotation) {
      const rotated=canvas(rotation===180 ? value.width : value.height,rotation===180 ? value.height : value.width);
      try {
        const ctx=context(rotated);
        ctx.translate(rotated.width/2,rotated.height/2);
        ctx.rotate(rotation*Math.PI/180);
        ctx.drawImage(value,-value.width/2,-value.height/2);
      } catch (error) { release(rotated); throw error; }
      release(value); value=rotated;
    }
    const blob=await encode(value);
    return {blob,thumbnail:await thumbnail(value,value.width,value.height),width:value.width,height:value.height};
  } finally { release(value); }
}

/** Export raster is bounded; the stored original is never modified. */
export async function imageToPng(blob:Blob):Promise<Blob> {
  const image=await decode(blob);
  let value:HTMLCanvasElement;
  try { value=draw(image.source,image.width,image.height,MAX_EDGE); } finally { image.close(); }
  try { return await encode(value,'image/png'); } finally { release(value); }
}
