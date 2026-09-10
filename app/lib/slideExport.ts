import { jsPDF } from 'jspdf';
import { Zip, ZipPassThrough } from 'fflate';
import type { Report } from './reports';
import type { StoredSlide } from './noteStorage';
import { imageToPng } from './slideImages';
import { deferred } from './deferred';

const FONT='"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif';

function safeFilename(value:string,maxLength=64) {
  const clean=value.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().replace(/[. ]+$/g,'');
  return Array.from(clean).slice(0,maxLength).join('').replace(/[. ]+$/g,'') || '未命名';
}

function selectedImage(slide:StoredSlide) {
  if (slide.mode==='original' && slide.original instanceof Blob && slide.original.size) return slide.original;
  if (slide.mode==='processed' && slide.processed instanceof Blob && slide.processed.size) return slide.processed;
  throw new Error(`图片“${slide.name}”的${slide.mode==='processed' ? '扫描版本' : '原图'}缺失或无效，请重新选择版本后导出。`);
}

function wrap(ctx:CanvasRenderingContext2D,text:string,width:number) {
  const lines:string[]=[];
  for (const paragraph of text.replace(/\r\n?/g,'\n').split('\n')) {
    let line='';
    for (const character of paragraph) {
      if (line && ctx.measureText(line+character).width>width) { lines.push(line); line=character; }
      else line+=character;
    }
    lines.push(line);
  }
  return lines;
}

async function cover(report:Report,count:number) {
  await document.fonts.ready;
  const value=document.createElement('canvas');
  value.width=1200; value.height=1;
  const ctx=value.getContext('2d');
  if (!ctx) throw new Error('浏览器无法创建导出封面。');
  try {
    const margin=90,width=value.width-margin*2;
    const blocks:{lines:string[];font:string;lineHeight:number;color:string;gap:number}[]=[];
    const add=(text:string,size:number,bold:boolean,color:string,gap:number) => {
      const font=`${bold ? '700' : '400'} ${size}px ${FONT}`;
      ctx.font=font;
      blocks.push({lines:wrap(ctx,text,width),font,lineHeight:Math.ceil(size*1.55),color,gap});
    };
    add('CMANCN 2026 · 报告 PPT 图集',27,true,'#002fa7',26);
    add(report.sourceTitle,44,true,'#071b56',34);
    add(`报告 ID：${report.id}　·　${count} 张 PPT`,25,false,'#566887',30);
    const fields:[string,string][]=[
      ['报告人',report.speaker],['单位',report.institution],['日期 / 时间',report.dateTime],
      ['会议地点',report.location],['专场',report.program],['Session',report.session],
      ['小节编号',report.abstractNo],['聚焦领域',report.field],['主持',report.chairman],
    ];
    for (const [label,text] of fields) if (text) add(`${label}：${text}`,28,false,'#203866',19);
    add('图片按本报告图集顺序排列 · 原始照片保留在本设备',22,false,'#566887',0);
    const height=Math.max(1697,Math.ceil(margin*2+blocks.reduce((sum,block)=>sum+block.lines.length*block.lineHeight+block.gap,0)));
    if (height>16000) throw new Error('报告元数据过长，封面超过安全画布尺寸；未截断任何报告信息，请缩短元数据后重试。');
    value.height=height;
    ctx.fillStyle='#f5f8ff'; ctx.fillRect(0,0,value.width,value.height);
    ctx.fillStyle='#002fa7'; ctx.fillRect(margin,45,100,7);
    ctx.textBaseline='top';
    let y=margin;
    for (const block of blocks) {
      ctx.font=block.font; ctx.fillStyle=block.color;
      for (const line of block.lines) { ctx.fillText(line,margin,y); y+=block.lineHeight; }
      y+=block.gap;
    }
    const {promise,resolve,reject}=deferred<Blob>();
    value.toBlob((blob)=>blob ? resolve(blob) : reject(new Error('封面生成失败，请释放设备内存后重试。')),'image/png');
    return {blob:await promise,width:value.width,height:value.height};
  } finally { value.width=1; value.height=1; }
}

/** Input array order is authoritative, independent of any stale persisted order field. */
export async function buildSlideExport(report:Report,slides:StoredSlide[],format:'pdf'|'png',onProgress?:(completed:number,total:number)=>void):Promise<{blob:Blob;filename:string}> {
  if (format!=='pdf' && format!=='png') throw new Error('不支持的导出格式。');
  // Snapshot the selection before the first await so edits during export cannot mix versions.
  const images=slides.map((slide)=>({name:slide.name,blob:selectedImage(slide)}));
  const reportSnapshot={...report,directions:[...report.directions]};
  const basename=`CMANCN 2026-报告${report.id}-${safeFilename(report.sourceTitle)}`;
  const total=images.length+1;
  onProgress?.(0,total);
  const first=await cover(reportSnapshot,images.length);
  if (format==='pdf') {
    // A naturally tall cover preserves every wrapped line at a readable physical font size.
    const coverWidth=210,coverHeight=coverWidth*first.height/first.width;
    const pdf=new jsPDF({unit:'mm',format:[coverWidth,coverHeight],orientation:'portrait',compress:true});
    pdf.setProperties({title:reportSnapshot.sourceTitle,subject:`神经病学年会报告 ${reportSnapshot.id}`,author:reportSnapshot.speaker,creator:'CMANCN 2026 本地图集'});
    pdf.addImage(new Uint8Array(await first.blob.arrayBuffer()),'PNG',0,0,coverWidth,coverHeight,'cover','FAST');
    onProgress?.(1,total);
    for (let i=0;i<images.length;i++) {
      const png=await imageToPng(images[i].blob);
      const bytes=new Uint8Array(await png.arrayBuffer());
      // Canvas generated this PNG; IHDR supplies dimensions without decoding it twice.
      const header=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      const imageWidth=header.getUint32(16),imageHeight=header.getUint32(20);
      pdf.addPage('a4',imageWidth>=imageHeight ? 'landscape' : 'portrait');
      const pageWidth=pdf.internal.pageSize.getWidth(),pageHeight=pdf.internal.pageSize.getHeight();
      const margin=7,scale=Math.min((pageWidth-margin*2)/imageWidth,(pageHeight-margin*2)/imageHeight);
      const width=imageWidth*scale,height=imageHeight*scale;
      pdf.addImage(bytes,'PNG',(pageWidth-width)/2,(pageHeight-height)/2,width,height,`slide-${i}`,'FAST');
      onProgress?.(i+2,total);
      const {promise,resolve}=deferred<void>();
      setTimeout(resolve,0); await promise;
    }
    return {blob:pdf.output('blob'),filename:`${basename}.pdf`};
  }
  const parts:BlobPart[]=[];
  const completion=deferred<Blob>();
  let failure:Error|undefined,finished=false;
  const zip=new Zip((error,data,final)=> {
    if (error) { failure=error; completion.reject(error); return; }
    parts.push(data as Uint8Array<ArrayBuffer>);
    if (final) { finished=true; completion.resolve(new Blob(parts,{type:'application/zip'})); }
  });
  // Attach a handler immediately: stream errors can precede the final await.
  void completion.promise.catch(()=>{});
  const append=async (name:string,blob:Blob) => {
    if (failure) throw failure;
    const entry=new ZipPassThrough(name);
    zip.add(entry);
    // PNG is already compressed. Pass-through avoids redundant compression and a second image map.
    const reader=blob.stream().getReader();
    try {
      for (;;) {
        const {done,value}=await reader.read();
        if (done) break;
        entry.push(value,false);
        if (failure) throw failure;
      }
      entry.push(new Uint8Array(0),true);
      if (failure) throw failure;
    } finally { reader.releaseLock(); }
  };
  try {
    await append('000-cover.png',first.blob);
    onProgress?.(1,total);
    for (let i=0;i<images.length;i++) {
      const png=await imageToPng(images[i].blob);
      await append(`${String(i+1).padStart(Math.max(3,String(images.length).length),'0')}-${safeFilename(images[i].name.replace(/\.[^.]+$/,''),48)}.png`,png);
      onProgress?.(i+2,total);
      const {promise,resolve}=deferred<void>();
      setTimeout(resolve,0); await promise;
    }
    zip.end();
    return {blob:await completion.promise,filename:`${basename}-PNG.zip`};
  } finally {
    if (!finished) zip.terminate();
    parts.length=0;
  }
}
