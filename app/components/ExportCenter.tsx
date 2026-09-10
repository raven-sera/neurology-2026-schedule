'use client';
import { deferred } from '../lib/deferred';
import { useDialog } from '../lib/useDialog';


import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CONFERENCE_DAYS, CONFERENCE_FIRST_MINUTE, CONFERENCE_LAST_MINUTE, sortReportsByDateTime, type Report } from '../lib/reports';
import { loadStoredNote } from '../lib/noteStorage';
import CalendarSchedule from './CalendarSchedule';
import { BrandLockup, HuiduQrCallout } from './BrandLockup';

export type ExportMode = 'schedule' | 'calendar' | 'notes';
type Stage = 'choose' | 'schedule-style' | 'generating' | 'preview' | 'error';
type RepeatingPageChrome = {
  contentSelector:string;
  headerSelector:string;
  footerSelector:string;
};
type PdfRenderOptions = {
  preserveBrowserTextLayout?:boolean;
  repeatingPageChrome?:RepeatingPageChrome;
  orientation?:'portrait'|'landscape';
};

function canvasHasContent(canvas:HTMLCanvasElement) {
  const context=canvas.getContext('2d',{willReadFrequently:true});
  if(!context||canvas.width<500||canvas.height<250)return false;
  const pixels=context.getImageData(0,0,canvas.width,canvas.height).data; let darkSamples=0;
  for(let y=0;y<canvas.height;y+=20){
    for(let x=0;x<canvas.width;x+=20){
      const offset=(y*canvas.width+x)*4;
      if(pixels[offset+3]>0&&pixels[offset]<190&&pixels[offset+1]<190&&pixels[offset+2]<190)darkSamples++;
      if(darkSamples>20)return true;
    }
  }
  return false;
}
function readBlobAsDataUrl(blob:Blob) {
  const {promise,resolve,reject}=deferred<string>();
  const reader=new FileReader();
  reader.addEventListener('load',()=>{
    if(typeof reader.result==='string')resolve(reader.result);
    else reject(new Error('Unable to inline PDF image.'));
  },{once:true});
  reader.addEventListener('error',()=>{
    reject(reader.error??new Error('Unable to read PDF image.'));
  },{once:true});
  reader.readAsDataURL(blob);
  return promise;
}

async function inlinePdfImages(root:HTMLElement) {
  const images=Array.from(root.querySelectorAll<HTMLImageElement>('img'));
  await Promise.all(images.map(async(image)=>{
    const source=image.currentSrc||image.src;
    image.removeAttribute('srcset');
    image.removeAttribute('loading');
    if(!source||source.startsWith('data:'))return;
    const response=await fetch(source);
    if(!response.ok)throw new Error(`Unable to load PDF image (${response.status}).`);
    image.src=await readBlobAsDataUrl(await response.blob());
  }));
}

async function preparePdfClone(clonedDocument:Document,clonedElement:HTMLElement) {
  const clonedSource=clonedElement.closest<HTMLElement>('.pdfSource')??clonedElement;
  Array.from(clonedDocument.body.children).forEach((child)=>{
    if(child===clonedSource||child.contains(clonedSource))return;
    (child as HTMLElement).style.setProperty('display','none','important');
  });
  clonedSource.style.left='0';
  clonedSource.style.top='0';
  clonedSource.style.zIndex='1';
  await inlinePdfImages(clonedElement);
}

function nextAnimationFrame() {
  const { promise, resolve } = deferred<void>();
  requestAnimationFrame(() => resolve());
  return promise;
}

async function waitForImages(root:HTMLElement) {
  await Promise.all(Array.from(root.querySelectorAll<HTMLImageElement>('img')).map((image)=>{
    if(image.complete)return Promise.resolve();
    const { promise, resolve } = deferred<void>();
    const finish=()=>{
      image.removeEventListener('load',finish);
      image.removeEventListener('error',finish);
      resolve();
    };
    image.addEventListener('load',finish,{once:true});
    image.addEventListener('error',finish,{once:true});
    return promise;
  }));
}

async function waitForBatchPagination(root:HTMLElement,expectedReports:number) {
  if(expectedReports===0)return;
  for(let attempt=0;attempt<120;attempt++){
    const reports=Array.from(root.querySelectorAll<HTMLElement>('[data-batch-note-pagination]'));
    if(reports.length===expectedReports&&reports.every((report)=>report.dataset.batchNotePagination==='ready'))return;
    await nextAnimationFrame();
  }
  throw new Error('Batch note pagination did not settle before export.');
}
function cropCanvas(source:HTMLCanvasElement,top:number,height:number) {
  const y=Math.max(0,Math.floor(top));
  const cropped=document.createElement('canvas');
  cropped.width=source.width;
  cropped.height=Math.max(1,Math.min(Math.ceil(height),source.height-y));
  const context=cropped.getContext('2d');
  if(!context)throw new Error('Unable to crop PDF page canvas.');
  context.drawImage(source,0,y,source.width,cropped.height,0,0,source.width,cropped.height);
  return cropped;
}


function collectPageBreakOffsets(content:HTMLElement,scale:number) {
  const contentRect=content.getBoundingClientRect();
  const maximum=Math.round(content.scrollHeight*scale);
  const offsets=new Set<number>([0,maximum]);
  const addOffset=(value:number)=>{
    const offset=Math.max(0,Math.min(maximum,Math.round(value*scale)));
    if(offset>0&&offset<maximum)offsets.add(offset);
  };
  content.querySelectorAll<HTMLElement>('[data-pdf-keep],img').forEach((element)=>{
    const rect=element.getBoundingClientRect();
    addOffset(rect.top-contentRect.top);
    addOffset(rect.bottom-contentRect.top+2);
  });
  content.querySelectorAll<HTMLElement>('h1,h2,h3').forEach((heading)=>{
    addOffset(heading.getBoundingClientRect().top-contentRect.top);
  });
  const walker=document.createTreeWalker(content,NodeFilter.SHOW_TEXT);
  const range=document.createRange();
  while(walker.nextNode()){
    const text=walker.currentNode as Text;
    if(!text.data.trim()||text.parentElement?.closest('[data-pdf-keep],h1,h2,h3'))continue;
    range.selectNodeContents(text);
    Array.from(range.getClientRects()).forEach((rect)=>{
      addOffset(rect.bottom-contentRect.top+2);
    });
  }
  return Array.from(offsets).sort((a,b)=>a-b);
}

function buildPageSlices(contentHeight:number,pageHeight:number,breakOffsets:number[]) {
  const slices:{start:number;end:number}[]=[];
  let start=0;
  while(start<contentHeight){
    const target=Math.min(contentHeight,start+pageHeight);
    let end=target;
    if(target<contentHeight){
      const minimum=start+40;
      for(const offset of breakOffsets){
        if(offset>minimum&&offset<=target-4)end=offset;
        if(offset>target)break;
      }
    }
    if(end<=start)end=target;
    slices.push({start,end});
    start=end;
  }
  return slices;
}

function drawPdfPageNumber(
  context:CanvasRenderingContext2D,
  page:number,
  total:number,
  width:number,
  height:number,
  footerHeight:number,
) {
  const fontSize=Math.max(14,Math.round(width*2.4/210));
  context.save();
  context.fillStyle='#18251e';
  context.font=`700 ${fontSize}px Arial, sans-serif`;
  context.textAlign='right';
  context.textBaseline='middle';
  context.fillText(`${page} / ${total}`,width-width*11/210,height-footerHeight/2);
  context.restore();
}

export async function renderPdf(
  source:HTMLDivElement,
  rect:DOMRect,
  {preserveBrowserTextLayout=false,repeatingPageChrome,orientation='portrait'}:PdfRenderOptions={},
) {
  const [{default:html2canvas},{jsPDF}]=await Promise.all([import('html2canvas'),import('jspdf')]);
  const pdf=new jsPDF({unit:'mm',format:'a4',orientation,compress:true});
  const pdfWidth=pdf.internal.pageSize.getWidth();
  const pdfHeight=pdf.internal.pageSize.getHeight();
  const fixedPages=Array.from(source.querySelectorAll<HTMLElement>('.pdfPage'));
  const pageHeight=rect.width*pdfHeight/pdfWidth;
  const fullPages=Math.floor(source.scrollHeight/pageHeight);
  const tailHeight=source.scrollHeight-fullPages*pageHeight;
  const fluidPageCount=Math.max(1,fullPages+(tailHeight>8?1:0));
  const previews:string[]=[];
  if(repeatingPageChrome){
    const content=source.querySelector<HTMLElement>(repeatingPageChrome.contentSelector);
    const header=source.querySelector<HTMLElement>(repeatingPageChrome.headerSelector);
    const footer=source.querySelector<HTMLElement>(repeatingPageChrome.footerSelector);
    if(!content||!header||!footer)throw new Error('Repeating PDF page chrome is unavailable.');
    const contentRect=content.getBoundingClientRect();
    const captureScale=Math.min(2,30000/Math.max(content.scrollHeight,1));
    const captureElement=(element:HTMLElement)=>{
      const elementRect=element.getBoundingClientRect();
      return html2canvas(element,{
        foreignObjectRendering:true,
        onclone:preparePdfClone,
        scale:captureScale,
        useCORS:true,
        backgroundColor:'#f4f0e6',
        logging:false,
        scrollX:0,
        scrollY:0,
        x:-elementRect.left,
        y:-elementRect.top,
        width:Math.ceil(elementRect.width),
        height:Math.ceil(Math.max(elementRect.height,element.scrollHeight)),
        windowWidth:Math.ceil(rect.width),
        windowHeight:Math.ceil(Math.max(source.scrollHeight,element.scrollHeight)),
      });
    };
    const [contentCanvas,headerCanvas,footerCanvas]=await Promise.all([
      captureElement(content),
      captureElement(header),
      captureElement(footer),
    ]);
    const outputWidth=contentCanvas.width;
    const outputHeight=Math.round(outputWidth*pdfHeight/pdfWidth);
    const headerHeight=Math.round(headerCanvas.height*outputWidth/headerCanvas.width);
    const footerHeight=Math.round(footerCanvas.height*outputWidth/footerCanvas.width);
    const chromeGap=Math.round(outputWidth*3/pdfWidth);
    const contentPageHeight=outputHeight-headerHeight-footerHeight-chromeGap*2;
    if(contentPageHeight<outputHeight*.55)throw new Error('Repeating PDF header or footer is too tall.');
    const contentScale=contentCanvas.width/contentRect.width;
    const breakOffsets=collectPageBreakOffsets(content,contentScale);
    const slices=buildPageSlices(contentCanvas.height,contentPageHeight,breakOffsets);

    for(let index=0;index<slices.length;index++){
      const {start,end}=slices[index];
      const page=document.createElement('canvas');
      page.width=outputWidth;
      page.height=outputHeight;
      const context=page.getContext('2d');
      if(!context)throw new Error('Unable to create repeated PDF page canvas.');
      context.fillStyle='#f4f0e6';
      context.fillRect(0,0,outputWidth,outputHeight);
      context.drawImage(headerCanvas,0,0,headerCanvas.width,headerCanvas.height,0,0,outputWidth,headerHeight);
      context.drawImage(
        contentCanvas,
        0,start,contentCanvas.width,end-start,
        0,headerHeight+chromeGap,outputWidth,end-start,
      );
      context.drawImage(
        footerCanvas,
        0,0,footerCanvas.width,footerCanvas.height,
        0,outputHeight-footerHeight,outputWidth,footerHeight,
      );
      drawPdfPageNumber(context,index+1,slices.length,outputWidth,outputHeight,footerHeight);
      if(!canvasHasContent(page))throw new Error(`PDF page ${index+1} is blank.`);
      if(index>0)pdf.addPage('a4',orientation);
      const imageData=page.toDataURL('image/jpeg',.96);
      previews.push(imageData);
      pdf.addImage(imageData,'JPEG',0,0,pdfWidth,pdfHeight,undefined,'FAST');
    }
    return {blob:pdf.output('blob'),previews};
  }

  const jobs=fixedPages.length
    ? fixedPages.map((element)=>({element,y:0,height:Math.ceil(element.getBoundingClientRect().height)}))
    : Array.from({length:fluidPageCount},(_,index)=>{
        const y=Math.floor(index*pageHeight);
        return {element:source,y,height:Math.min(Math.ceil(pageHeight),source.scrollHeight-y)};
      });

  const captureWholeSource=preserveBrowserTextLayout&&fixedPages.length===0;
  const browserLayoutScale=captureWholeSource
    ? Math.min(2,30000/Math.max(source.scrollHeight,1))
    : 2;
  const browserLayoutCanvas=captureWholeSource
    ? await html2canvas(source,{
        foreignObjectRendering:true,
        onclone:preparePdfClone,
        scale:browserLayoutScale,
        useCORS:true,
        backgroundColor:'#f4f0e6',
        logging:false,
        scrollX:0,
        scrollY:0,
        x:0,
        y:0,
        width:Math.ceil(rect.width),
        height:Math.ceil(source.scrollHeight),
        windowWidth:Math.ceil(rect.width),
        windowHeight:Math.ceil(source.scrollHeight),
      })
    : null;

  for(let index=0;index<jobs.length;index++){
    const job=jobs[index];
    const jobRect=job.element.getBoundingClientRect();
    const canvas=browserLayoutCanvas
      ? cropCanvas(browserLayoutCanvas,job.y*browserLayoutScale,job.height*browserLayoutScale)
      : await html2canvas(job.element,{
          foreignObjectRendering:preserveBrowserTextLayout,
          onclone:preparePdfClone,
          scale:2,
          useCORS:true,
          backgroundColor:'#f4f0e6',
          logging:false,
          scrollX:0,
          scrollY:0,
          x:0,
          y:job.y,
          width:Math.ceil(jobRect.width),
          height:job.height,
          windowWidth:Math.ceil(rect.width),
          windowHeight:Math.max(job.height,Math.ceil(job.element.scrollHeight)),
        });
    if(!canvasHasContent(canvas))throw new Error(`PDF page ${index+1} is blank.`);
    if(index>0)pdf.addPage('a4',orientation);
    // Normalize every exported page to the exact A4 aspect ratio (210 × 297 mm).
    // This is especially important for a short final schedule page: without padding,
    // browsers may visually/physically print the content as a smaller custom page.
    const normalized=document.createElement('canvas');
    normalized.width=canvas.width;
    normalized.height=Math.round(canvas.width*pdfHeight/pdfWidth);
    const normalizedContext=normalized.getContext('2d');
    if(!normalizedContext)throw new Error('Unable to create A4 page canvas.');
    normalizedContext.fillStyle='#f4f0e6';
    normalizedContext.fillRect(0,0,normalized.width,normalized.height);
    const drawHeight=Math.min(canvas.height,normalized.height);
    normalizedContext.drawImage(canvas,0,0,canvas.width,drawHeight,0,0,normalized.width,drawHeight);
    const imageData=normalized.toDataURL('image/jpeg',.96);
    previews.push(imageData);
    pdf.addImage(imageData,'JPEG',0,0,pdfWidth,pdfHeight,undefined,'FAST');
  }
  return {blob:pdf.output('blob'),previews};
}


function groupByDate(input:Report[]) {
  const groups=new Map<string,Report[]>();
  input.forEach((report)=>{
    const day=report.dateTime.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? '日期待确认';
    groups.set(day,[...(groups.get(day)??[]),report]);
  });
  return Array.from(groups.entries());
}

type SchedulePageBlock = { day:string; items:Report[]; continued?:boolean };
type SchedulePage = { blocks:SchedulePageBlock[]; first:boolean };

function ScheduleTable({day,items,continued=false,measure=false}:{day:string;items:Report[];continued?:boolean;measure?:boolean}) {
  return <section className="scheduleDay" data-measure-day={measure?day:undefined}>
    <div className="scheduleDayTitle"><span>{day}{continued?' · 续':''}</span><b>{items.length} 场{continued?'（本页）':''}</b></div>
    <table>
      <thead><tr><th>时间</th><th>会议内容</th><th>汇报人</th><th>人员单位</th><th>地点</th><th>类型 / 专场</th><th>参会打卡</th></tr></thead>
      <tbody>{items.map((report)=><tr key={report.id} data-measure-report={measure?report.id:undefined}>
        <td><b>{report.dateTime.replace(`${day} `,'')}</b></td>
        <td>{report.sourceTitle}</td><td>{report.speaker}</td><td>{report.institution}</td><td>{report.location}</td>
        <td><b>{report.kind}</b><small>{report.program}{report.session ? ` · ${report.session}` : ''}</small></td>
        <td className="attendanceCell"><span className="attendanceBox">□</span><small>到场</small></td>
      </tr>)}</tbody>
    </table>
  </section>;
}

function ScheduleDocument({ reports }:{reports:Report[]}) {
  const groups=useMemo(()=>groupByDate(reports),[reports]);
  const measureRef=useRef<HTMLDivElement>(null);
  const [pages,setPages]=useState<SchedulePage[]>([]);

  useLayoutEffect(()=>{
    const root=measureRef.current;
    if(!root)return;
    const paginate=()=>{
      const page=root.querySelector<HTMLElement>('.scheduleMeasurePage');
      const brandBar=root.querySelector<HTMLElement>('.pdfBrandBar');
      const firstHeader=root.querySelector<HTMLElement>('.pdfCoverHeader');
      const intro=root.querySelector<HTMLElement>('.pdfIntro');
      const continuationHeader=root.querySelector<HTMLElement>('.scheduleContinuationHeader');
      const footer=root.querySelector<HTMLElement>('.pdfFooter');
      const sampleDay=root.querySelector<HTMLElement>('.scheduleDayTitle');
      const sampleHead=root.querySelector<HTMLElement>('thead');
      if(!page||!brandBar||!firstHeader||!intro||!continuationHeader||!footer||!sampleDay||!sampleHead)return;

      const style=getComputedStyle(page);
      const innerHeight=page.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
      const footerReserve=footer.getBoundingClientRect().height+10;
      const firstUsed=brandBar.getBoundingClientRect().height+firstHeader.getBoundingClientRect().height+intro.getBoundingClientRect().height+22;
      const continuationUsed=continuationHeader.getBoundingClientRect().height+14;
      const dayHeight=sampleDay.getBoundingClientRect().height;
      const headHeight=sampleHead.getBoundingClientRect().height;
      const blockGap=22;
      const rowHeights=new Map<number,number>();
      root.querySelectorAll<HTMLElement>('tr[data-measure-report]').forEach((row)=>rowHeights.set(Number(row.dataset.measureReport),row.getBoundingClientRect().height));

      const result:SchedulePage[]=[];
      let current:SchedulePage={blocks:[],first:true};
      let used=firstUsed;
      const capacity=innerHeight-footerReserve;
      const pushPage=()=>{result.push(current);current={blocks:[],first:false};used=continuationUsed;};

      for(const [day,items] of groups){
        let cursor=0;
        let continued=false;
        while(cursor<items.length){
          const fixed=dayHeight+headHeight+(current.blocks.length?blockGap:0);
          const firstRowHeight=rowHeights.get(items[cursor].id)??42;
          if(used+fixed+firstRowHeight>capacity&&current.blocks.length){pushPage();continue;}
          const block:SchedulePageBlock={day,items:[],continued};
          used+=fixed;
          while(cursor<items.length){
            const report=items[cursor];
            const rowHeight=rowHeights.get(report.id)??42;
            if(used+rowHeight>capacity&&block.items.length)break;
            block.items.push(report); used+=rowHeight; cursor++;
          }
          current.blocks.push(block);
          if(cursor<items.length){pushPage();continued=true;}
        }
      }
      if(current.blocks.length||!result.length)result.push(current);
      setPages(result);
    };
    paginate();
    let cancelled=false;
    document.fonts?.ready.then(()=>{if(!cancelled)paginate();});
    return()=>{cancelled=true;};
  },[groups]);

  return <div className="pdfDocument scheduleDocument">
    <div className="scheduleMeasure" ref={measureRef} aria-hidden="true">
      <section className="scheduleMeasurePage">
        <div className="pdfBrandBar"><BrandLockup compact/></div><header className="pdfCoverHeader"><div><span>PERSONAL ITINERARY · CMANCN 2026</span><h1>我的听会日程</h1></div><aside><b>{reports.length}</b><span>场已选报告</span></aside></header>
        <p className="pdfIntro">按大会日期与报告开始时间排序。场地仍以大会最终通知为准。</p>
        <header className="scheduleContinuationHeader"><BrandLockup compact/><b>我的听会日程 · 续</b></header>
        {groups.map(([day,items])=><ScheduleTable key={day} day={day} items={items} measure/>)}
        <footer className="pdfFooter"><HuiduQrCallout compact/><b>私人定制 · 仅供听会规划</b></footer>
      </section>
    </div>
    {pages.map((page,pageIndex)=><section className="pdfPage schedulePdfPage" key={pageIndex}>
      {page.first
        ? <><div className="pdfBrandBar"><BrandLockup compact/></div><header className="pdfCoverHeader"><div><span>PERSONAL ITINERARY · CMANCN 2026</span><h1>我的听会日程</h1></div><aside><b>{reports.length}</b><span>场已选报告</span></aside></header><p className="pdfIntro">按大会日期与报告开始时间排序。日程表不包含笔记内容；“参会打卡”可用于打印后手写勾选。场地仍以大会最终通知为准。</p></>
        : <header className="scheduleContinuationHeader"><BrandLockup compact/><b>我的听会日程 · {pageIndex+1}</b></header>}
      <div className="schedulePageBody">{page.blocks.map((block,index)=><ScheduleTable key={`${block.day}-${index}`} day={block.day} items={block.items} continued={block.continued}/>)}</div>
      <footer className="pdfFooter"><HuiduQrCallout compact/><b>{pageIndex+1} / {pages.length} · 私人定制</b></footer>
    </section>)}
  </div>;
}

function formatCalendarMinute(minute:number) {
  return `${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
}

function getCalendarPrintRanges(reports:Report[]) {
  const conferenceStart=Math.floor(CONFERENCE_FIRST_MINUTE/60)*60;
  const conferenceEnd=Math.ceil(CONFERENCE_LAST_MINUTE/60)*60;
  const intervals=reports.flatMap((report)=>{
    const match=report.dateTime.match(/^(\d{4}-\d{2}-\d{2}).*?(\d{2}):(\d{2})-(\d{2}):(\d{2})/);
    if(!match||!CONFERENCE_DAYS.some((day)=>day.date===match[1]))return [];
    return [{start:Number(match[2])*60+Number(match[3]),end:Number(match[4])*60+Number(match[5])}];
  });
  if(!intervals.length)return [{startMinute:conferenceStart,endMinute:Math.min(conferenceEnd,conferenceStart+60)}];
  const firstMinute=Math.max(conferenceStart,Math.floor(Math.min(...intervals.map(({start})=>start))/60)*60);
  const lastMinute=Math.min(conferenceEnd,Math.max(
    firstMinute+60,
    Math.ceil(Math.max(...intervals.map(({end})=>end))/60)*60,
  ));
  return Array.from(
    {length:Math.max(1,(lastMinute-firstMinute)/60)},
    (_,index)=>({startMinute:firstMinute+index*60,endMinute:firstMinute+(index+1)*60}),
  );
}

function ScheduleCalendarDocument({ reports }:{reports:Report[]}) {
  const ranges=getCalendarPrintRanges(reports);
  return <div className="pdfDocument calendarDocument">
    {ranges.map(({startMinute,endMinute},pageIndex)=><section className="pdfPage calendarPdfPage" key={startMinute}>
      <div className="pdfBrandBar"><BrandLockup compact/></div>
      <header className="pdfCoverHeader">
        <div><span>CONFERENCE CALENDAR · CMANCN 2026</span><h1>我的听会日历</h1></div>
        <aside><b>{reports.length}</b><span>场已选报告</span></aside>
      </header>
      <p className="pdfIntro">第 {pageIndex+1} 页 · {formatCalendarMinute(startMinute)}–{formatCalendarMinute(endMinute)}；三天报告按真实时间位置排列，同时段报告并列呈现。</p>
      <div className="calendarPdfBody"><CalendarSchedule
        reports={reports}
        variant="pdf"
        rangeStartMinute={startMinute}
        rangeEndMinute={endMinute}
      /></div>
      <footer className="pdfFooter"><HuiduQrCallout compact/><b>{pageIndex+1} / {ranges.length} · 私人定制</b></footer>
    </section>)}
  </div>;
}
type BatchNoteSlice = { start:number; end:number };

function notePlainText(html:string) {
  return html
    .replace(/<br\s*\/?>/gi,'\n')
    .replace(/<\/(?:p|div|li|h[1-6]|blockquote)>/gi,'\n')
    .replace(/<[^>]+>/g,'')
    .replace(/&(?:nbsp|#160);/gi,' ')
    .replace(/&amp;/gi,'&')
    .replace(/&lt;/gi,'<')
    .replace(/&gt;/gi,'>')
    .trim();
}

function noteHasVisibleContent(html:string) {
  return Boolean(notePlainText(html))||/<(?:img|hr|table)\b/i.test(html);
}

function BatchNoteGrid({reportId,pageIndex}:{reportId:number;pageIndex:number}) {
  const patternId=`batch-note-grid-${reportId}-${pageIndex}`;
  return <svg className="batchNoteGridPattern" aria-hidden="true" focusable="false">
    <defs>
      <pattern id={patternId} width="18.9" height="18.9" patternUnits="userSpaceOnUse">
        <path d="M 18.9 0 L 0 0 0 18.9" fill="none" stroke="#53675b" strokeOpacity=".28" strokeWidth=".8"/>
      </pattern>
    </defs>
    <rect width="100%" height="100%" fill={`url(#${patternId})`}/>
  </svg>;
}

function BatchReportNotes({report,note}:{report:Report;note:string}) {
  const contentRef=useRef<HTMLDivElement>(null);
  const viewportRef=useRef<HTMLDivElement>(null);
  const [slices,setSlices]=useState<BatchNoteSlice[]>([{start:0,end:0}]);
  const [paginationReady,setPaginationReady]=useState(false);
  const hasNote=noteHasVisibleContent(note);
  const noteLength=Array.from(notePlainText(note).replace(/\s/g,'')).length;

  useLayoutEffect(()=>{
    const content=contentRef.current;
    const viewport=viewportRef.current;
    if(!content||!viewport)return;
    let cancelled=false;
    setPaginationReady(false);
    const paginate=()=>{
      if(cancelled)return;
      const style=getComputedStyle(viewport);
      const pageHeight=Math.max(1,Math.floor(
        viewport.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom),
      ));
      const contentHeight=hasNote?Math.max(1,Math.ceil(content.scrollHeight)):0;
      const next=hasNote
        ? buildPageSlices(contentHeight,pageHeight,collectPageBreakOffsets(content,1))
        : [{start:0,end:0}];
      setSlices((current)=>{
        const unchanged=current.length===next.length&&current.every((slice,index)=>(
          slice.start===next[index].start&&slice.end===next[index].end
        ));
        return unchanged?current:next;
      });
      setPaginationReady(true);
    };
    paginate();
    const resizeObserver=typeof ResizeObserver==='undefined'?null:new ResizeObserver(paginate);
    resizeObserver?.observe(content);
    resizeObserver?.observe(viewport);
    const images=Array.from(content.querySelectorAll<HTMLImageElement>('img'));
    images.forEach((image)=>{
      image.addEventListener('load',paginate);
      image.addEventListener('error',paginate);
    });
    void document.fonts?.ready.then(paginate);
    return()=>{
      cancelled=true;
      resizeObserver?.disconnect();
      images.forEach((image)=>{
        image.removeEventListener('load',paginate);
        image.removeEventListener('error',paginate);
      });
    };
  },[hasNote,note]);

  return <div className="batchReportNotes" data-batch-note-pagination={paginationReady?'ready':'pending'}>
    <div className="batchNoteMeasureShell" aria-hidden="true">
      <div
        className="noteRichContent batchNoteRichContent"
        dangerouslySetInnerHTML={{__html:note}}
        ref={contentRef}
      />
    </div>
    {slices.map((slice,pageIndex)=><section
      className="pdfPage batchNotePage"
      data-note-report-id={report.id}
      data-note-page={pageIndex+1}
      key={`${report.id}-${pageIndex}-${slice.start}`}
    >
      <header className="batchNoteMasthead">
        <BrandLockup compact/>
        <div><span>CMANCN 2026 · REPORT NOTES</span><b>{report.speaker}</b></div>
      </header>
      <section className="batchNoteReportCard" data-pdf-keep>
        <div className="batchNoteKicker"><span>{report.field} · {report.directions.slice(0,2).join(' / ')}</span></div>
        <h1>{report.sourceTitle}</h1>
        <dl>
          <div><dt>时间</dt><dd>{report.dateTime}</dd></div>
          <div><dt>地点</dt><dd>{report.location}</dd></div>
          <div><dt>报告人</dt><dd>{report.speaker}</dd></div>
          <div><dt>单位</dt><dd>{report.institution}</dd></div>
        </dl>
      </section>
      <section className="batchNoteWorkspace">
        <header>
          <div><span>{hasNote?'WEB NOTE':'HANDWRITING PAPER'}</span><strong>{pageIndex===0?'听会笔记':'听会笔记 · 续页'}</strong></div>
          <b>{hasNote?`${noteLength} 字`:'打印后可直接手写'}</b>
        </header>
        <div className="batchNoteGridSurface">
          <BatchNoteGrid reportId={report.id} pageIndex={pageIndex}/>
          <div className="batchNoteFlowViewport" ref={pageIndex===0?viewportRef:undefined}>
            {hasNote&&<div
              className="batchNoteSliceClip"
              style={{height:`${Math.max(1,slice.end-slice.start-(slice.start?3:0))}px`}}
            >
              <div
                className="noteRichContent batchNoteRichContent batchNoteFlow"
                dangerouslySetInnerHTML={{__html:note}}
                style={{top:`-${slice.start+(slice.start?3:0)}px`}}
              />
            </div>}
            {slice.start>0&&<span className="batchNoteContinuationMask" aria-hidden="true"/>}
          </div>
        </div>
      </section>
      <footer className="batchNoteFooter"><HuiduQrCallout compact/><b>笔记页 {pageIndex+1} / {slices.length}</b></footer>
    </section>)}
  </div>;
}

function NotesDocument({ reports, notes }:{reports:Report[];notes:Record<number,string>}) {
  return <div className="pdfDocument notesDocument">{reports.map((report)=><BatchReportNotes
    key={report.id}
    report={report}
    note={notes[report.id]??''}
  />)}</div>;
}

async function readSavedNotes(reports:Report[]) {
  const entries=await Promise.all(reports.map(async(report)=>{
    const stored=await loadStoredNote(report.id);
    return [report.id,stored.html] as const;
  }));
  return Object.fromEntries(entries) as Record<number,string>;
}

export default function ExportCenter({
  reports,
  onClose,
  onExported,
  initialMode,
  clearAfterExport=false,
}:{
  reports:Report[];
  onClose:()=>void;
  onExported?:()=>void;
  initialMode?:ExportMode;
  clearAfterExport?:boolean;
}) {
  const directMode = initialMode === 'notes' || initialMode === 'calendar' ? initialMode : null;
  const [mode,setMode]=useState<ExportMode|null>(directMode);
  const [stage,setStage]=useState<Stage>(
    initialMode === 'schedule' ? 'schedule-style' : directMode ? 'generating' : 'choose',
  );
  const [pdfUrl,setPdfUrl]=useState('');
  const [previewImages,setPreviewImages]=useState<string[]>([]);
  const [filename,setFilename]=useState('');
  const [portalReady,setPortalReady]=useState(false);
  useDialog('.exportOverlay:not(.singleNoteExportOverlay)', onClose);
  const [savedNotes,setSavedNotes]=useState<Record<number,string>>({});
  const [notesReady,setNotesReady]=useState(initialMode!=='notes');
  const sourceRef=useRef<HTMLDivElement>(null);
  const sorted=useMemo(()=>sortReportsByDateTime(reports),[reports]);
  const exportTitle=stage==='schedule-style'
    ? '选择日程导出形式'
    : mode==='calendar'
      ? '导出日历日程'
      : initialMode==='notes'||mode==='notes'
        ? '批量导出笔记'
        : initialMode==='schedule'||mode==='schedule'
          ? '导出我的日程'
          : '自定义导出';

  useEffect(()=>{const frame=requestAnimationFrame(()=>setPortalReady(true));return()=>cancelAnimationFrame(frame);},[]);
  useEffect(()=>()=>{if(pdfUrl)URL.revokeObjectURL(pdfUrl);},[pdfUrl]);
  useEffect(()=>{
    if(stage!=='generating'||!mode)return;
    let cancelled=false;
    if(mode==='notes'&&!notesReady){
      void readSavedNotes(sorted).then((notes)=>{
        if(cancelled)return;
        setSavedNotes(notes);
        setNotesReady(true);
      }).catch((error)=>{
        console.error(error);
        if(!cancelled)setStage('error');
      });
      return()=>{cancelled=true;};
    }
    const source=sourceRef.current;
    if(!source)return;
    const build=async()=>{
      try {
        await document.fonts?.ready;
        await waitForImages(source);
        await nextAnimationFrame();
        await nextAnimationFrame();
        if(mode==='notes')await waitForBatchPagination(source,sorted.length);
        source.classList.add('isCapturing');
        await nextAnimationFrame();
        await nextAnimationFrame();
        const rect=source.getBoundingClientRect();
        if(rect.width<500||rect.height<500||rect.left<-1)throw new Error(`PDF render source is outside the capture area: ${JSON.stringify({width:rect.width,height:rect.height,left:rect.left})}`);
        const nextFilename=mode==='schedule'
          ? 'CMANCN 2026-私人听会日程-表格版.pdf'
          : mode==='calendar'
            ? 'CMANCN 2026-私人听会日程-日历版.pdf'
            : 'CMANCN 2026-听会笔记.pdf';
        const {blob,previews}=await renderPdf(source,rect,mode==='calendar'?{orientation:'landscape'}:undefined);
        if(blob.size<8000)throw new Error(`Generated PDF is unexpectedly small (${blob.size} bytes).`);
        if(cancelled)return;
        const url=URL.createObjectURL(blob); setFilename(nextFilename); setPdfUrl(url); setPreviewImages(previews); setStage('preview'); onExported?.();
      } catch(error) { console.error(error); if(!cancelled)setStage('error'); }
      finally { source.classList.remove('isCapturing'); }
    };
    void build();
    return()=>{cancelled=true;};
  },[mode,notesReady,onExported,portalReady,sorted,stage]);

  const choose=(nextMode:ExportMode)=>{
    if(nextMode==='notes')setSavedNotes({});
    setNotesReady(nextMode!=='notes');
    setMode(nextMode);
    setStage('generating');
  };
  const chooseScheduleStyle=()=>{setMode(null);setStage('schedule-style');};
  const print=()=>{const frame=document.querySelector<HTMLIFrameElement>('.pdfPrintFrame');frame?.contentWindow?.focus();frame?.contentWindow?.print();};

  return <><div className="exportOverlay" role="dialog" aria-modal="true" aria-labelledby="export-title"><div className={`exportModal ${stage==='preview'?'previewMode':''}`}>
    <header className="exportTop"><div><span>CUSTOM EXPORT</span><h2 id="export-title">{exportTitle}</h2></div><button onClick={onClose} aria-label="关闭导出">×</button></header>
    {stage==='choose'&&<><p className="exportLead">已选 {reports.length} 场内容。请选择你准备使用的文件。</p><div className="exportChoices"><button type="button" onClick={chooseScheduleStyle}><span>01</span><div><small>PERSONAL ITINERARY</small><h3>日程安排</h3><p>继续选择表格清单或三日会议日历，两种版式均按开始时间排序。</p></div><b>选择版式 ↗</b></button><button type="button" onClick={()=>choose('notes')}><span>02</span><div><small>CONFERENCE NOTES</small><h3>听会笔记</h3><p>一场内容对应一篇笔记，并自动带入该看板笔记区已经保存的内容。</p></div><b>选择 ↗</b></button></div>{clearAfterExport&&<p className="exportWarning">PDF 成功生成后，这 {reports.length} 条收藏将从灵动岛清空。</p>}</>}
    {stage==='schedule-style'&&<><p className="exportLead">已选 {reports.length} 场报告。请选择日程 PDF 的呈现形式。</p><div className="exportChoices scheduleStyleChoices"><button type="button" onClick={()=>choose('schedule')}><span>01</span><div><small>TABLE ITINERARY</small><h3>表格日程</h3><p>沿用原版清单，完整汇总题目、报告人、单位、地点、专场与参会打卡。</p></div><b>生成表格版 ↗</b></button><button type="button" onClick={()=>choose('calendar')}><span>02</span><div><small>CALENDAR ITINERARY</small><h3>日历日程</h3><p>{CONFERENCE_DAYS[0]?.monthDay}–{CONFERENCE_DAYS.at(-1)?.monthDay}；各日分列、时间纵轴和同时段并列关系与网页日历保持一致，包含全部夜场。</p></div><b>生成日历版 ↗</b></button></div>{clearAfterExport&&<p className="exportWarning">PDF 成功生成后，这 {reports.length} 条收藏将从灵动岛清空。</p>}</>}
    {stage==='generating'&&<div className="exportGenerating"><span className="generatingOrb">PDF</span><h3>正在排版你的私人文件</h3><p>{mode==='calendar'?'正在按网页日历版式生成三天时间轴，并按小时分页保持文字可读。':'整理日程顺序、分页和中文字体，请稍候。'}</p></div>}
    {stage==='error'&&<div className="exportError"><b>生成没有完成</b><p>{clearAfterExport?'收藏尚未清除，可以关闭后重新尝试。':'我的日程和收藏均保持不变，可以重新生成。'}</p><button onClick={()=>setStage('generating')}>重新生成</button></div>}
    {stage==='preview'&&<div className="previewArea"><div className="previewToolbar"><div><b>PDF 预览</b><span>{filename} · {reports.length} 场</span></div><a href={pdfUrl} download={filename}>保存到本地 ↓</a><button className="printButton" onClick={print}>打印 ↗</button></div><div className="pdfPreviewPages" aria-label={`${filename} PDF 页面预览`}>{previewImages.map((image,index)=><figure key={index}><img src={image} alt={`${filename} 第 ${index+1} 页`}/><figcaption>{index+1} / {previewImages.length}</figcaption></figure>)}</div><iframe className="pdfPrintFrame" src={pdfUrl} title={`${filename} 打印文件`}/><p>{clearAfterExport?'导出完成，本次收藏已从灵动岛清除。PDF 预览仍会保留至关闭窗口。':'导出完成，我的日程和收藏均保持不变。'}</p></div>}
  </div></div>
  {portalReady&&createPortal(<div className={`pdfSource ${mode==='calendar'?'isLandscape':''}`} aria-hidden="true" ref={sourceRef}>{mode==='schedule'?<ScheduleDocument reports={sorted}/>:mode==='calendar'?<ScheduleCalendarDocument reports={sorted}/>:mode==='notes'?<NotesDocument reports={sorted} notes={savedNotes}/>:null}</div>,document.body)}
  </>;
}
