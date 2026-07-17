"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import genresData from "../data/genres.json";
import instrumentsData from "../data/instruments.json";
import moodsData from "../data/moods.json";
import shoutsData from "../data/shouts.json";

type Genre = (typeof genresData)[number];
type Instrument = (typeof instrumentsData)[number] & { drum?: boolean };
type PromptPair = { id: number; style: string; lyrics: string; meta: string; detectedKey?: string };

const icon = (glyph:string) => function Icon({size=16}:{size?:number}) { return <span aria-hidden="true" style={{fontSize:size,lineHeight:1}}>{glyph}</span>; };
const Upload=icon("⇧"), WandSparkles=icon("✦"), FlaskConical=icon("⚗"), Copy=icon("⧉"), ExternalLink=icon("↗"), LockKeyhole=icon("◆"), Music2=icon("♫"), History=icon("◷"), RotateCcw=icon("↺"), Gauge=icon("◉"), Mic2=icon("♪");

const PC_NAMES = ["C","C♯","D","E♭","E","F","F♯","G","A♭","A","B♭","B"];
const majorProfile = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const minorProfile = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
const KEY_CONFIDENCE_THRESHOLD = 0.6;
const MAX_RECORDING_SECONDS = 60;
const badPairs = [["Progressive House","Rawstyle"],["Deep House","Tearout"],["Tropical House","Hard Techno"],["Chillout","Hardcore"]];
const uncharted = [["Amapiano","Kompang"],["Midtempo Bass","Suona (bold)"],["Psytrance","Suona (maximum)"],["Liquid DnB","Guzheng"]];

function pick<T>(arr: readonly T[]) { return arr[Math.floor(Math.random() * arr.length)]; }
function clamp(n:number,a:number,b:number){ return Math.max(a,Math.min(b,n)); }
function nearestRange(bpm:number, selected:Genre[]) {
  if (!selected.length) return Math.round(bpm);
  const lo = Math.max(...selected.map(g => g.bpmRange[0]));
  const hi = Math.min(...selected.map(g => g.bpmRange[1]));
  if (lo <= hi) return Math.round(clamp(bpm,lo,hi));
  const centers = selected.map(g => (g.bpmRange[0] + g.bpmRange[1]) / 2);
  return Math.round(centers.reduce((a,b)=>a+b,0)/centers.length);
}
function rotate<T>(a:T[], n:number){ return [...a.slice(n),...a.slice(0,n)]; }
function pearson(a:number[],b:number[]){
  const av=a.reduce((s,x)=>s+x,0)/a.length,bv=b.reduce((s,x)=>s+x,0)/b.length;
  const num=a.reduce((s,x,i)=>s+(x-av)*(b[i]-bv),0);
  const den=Math.sqrt(a.reduce((s,x)=>s+(x-av)**2,0)*b.reduce((s,x)=>s+(x-bv)**2,0));
  return den ? num/den : 0;
}
function supportedRecordingType(){
  if(typeof MediaRecorder === "undefined") return null;
  const types=["audio/webm;codecs=opus","audio/webm","audio/mp4;codecs=mp4a.40.2","audio/mp4"];
  if(typeof MediaRecorder.isTypeSupported !== "function") return types[1];
  return types.find(type=>MediaRecorder.isTypeSupported(type)) || null;
}
function rawAudioExtension(mimeType:string){ return mimeType.includes("mp4") ? "m4a" : "webm"; }
function encodeWav(audioBuffer:AudioBuffer){
  const channelCount=audioBuffer.numberOfChannels;
  const sampleRate=audioBuffer.sampleRate;
  const frameCount=audioBuffer.length;
  const bytesPerSample=2;
  const dataSize=frameCount*channelCount*bytesPerSample;
  const bytes=new ArrayBuffer(44+dataSize);
  const view=new DataView(bytes);
  const write=(offset:number,value:string)=>{ for(let i=0;i<value.length;i++) view.setUint8(offset+i,value.charCodeAt(i)); };
  write(0,"RIFF"); view.setUint32(4,36+dataSize,true); write(8,"WAVE");
  write(12,"fmt "); view.setUint32(16,16,true); view.setUint16(20,1,true);
  view.setUint16(22,channelCount,true); view.setUint32(24,sampleRate,true);
  view.setUint32(28,sampleRate*channelCount*bytesPerSample,true);
  view.setUint16(32,channelCount*bytesPerSample,true); view.setUint16(34,16,true);
  write(36,"data"); view.setUint32(40,dataSize,true);
  const channels=Array.from({length:channelCount},(_,index)=>audioBuffer.getChannelData(index));
  let offset=44;
  for(let frame=0;frame<frameCount;frame++){
    for(let channel=0;channel<channelCount;channel++){
      const sample=Math.max(-1,Math.min(1,channels[channel][frame]));
      view.setInt16(offset,sample<0?sample*0x8000:sample*0x7fff,true);
      offset+=bytesPerSample;
    }
  }
  return new Blob([bytes],{type:"audio/wav"});
}
function estimateBpm(data:Float32Array,sampleRate:number){
  const hop=1024, energy:number[]=[];
  for(let i=0;i+hop<data.length;i+=hop){let s=0;for(let j=0;j<hop;j++)s+=data[i+j]*data[i+j];energy.push(Math.sqrt(s/hop));}
  const novelty=energy.map((e,i)=>Math.max(0,e-(energy[i-1]||e))), mean=novelty.reduce((a,b)=>a+b,0)/novelty.length;
  const peaks=novelty.map((v,i)=>v>mean*2.2&&v>(novelty[i-1]||0)&&v>(novelty[i+1]||0)?i:-1).filter(i=>i>=0);
  if(peaks.length<4) throw new Error("no stable onsets");
  const scores=new Map<number,number>();
  for(let i=1;i<peaks.length;i++){let tempo=60*sampleRate/((peaks[i]-peaks[i-1])*hop);while(tempo<70)tempo*=2;while(tempo>190)tempo/=2;const k=Math.round(tempo);scores.set(k,(scores.get(k)||0)+1);}
  return [...scores.entries()].sort((a,b)=>b[1]-a[1])[0][0];
}
function yinPitch(buf:Float32Array,sampleRate:number){
  const half=Math.floor(buf.length/2), diff=new Float32Array(half), cmnd=new Float32Array(half);let run=0;
  for(let tau=1;tau<half;tau++){let d=0;for(let i=0;i<half;i++){const x=buf[i]-buf[i+tau];d+=x*x;}diff[tau]=d;run+=d;cmnd[tau]=d*tau/(run||1);}
  for(let tau=Math.floor(sampleRate/1200);tau<Math.min(half,Math.floor(sampleRate/50));tau++)if(cmnd[tau]<.13&&cmnd[tau]<=cmnd[tau+1])return sampleRate/tau;
  return null;
}

export default function Home() {
  const [mode,setMode]=useState<"standard"|"surprise"|"chaos">("standard");
  const [base,setBase]=useState("Progressive House");
  const [drop,setDrop]=useState("Big Room House");
  const [instrument,setInstrument]=useState("Đàn bầu");
  const [mood,setMood]=useState("Euphoric");
  const [bpm,setBpm]=useState(128);
  const [detected,setDetected]=useState<number|null>(null);
  const [detectedKey,setDetectedKey]=useState<string|null>(null);
  const [instrumental,setInstrumental]=useState(true);
  const [shouts,setShouts]=useState(false);
  const [analyzing,setAnalyzing]=useState(false);
  const [analysisError,setAnalysisError]=useState("");
  const [recordingSupported,setRecordingSupported]=useState<boolean|null>(null);
  const [isRecording,setIsRecording]=useState(false);
  const [recordingRemaining,setRecordingRemaining]=useState(MAX_RECORDING_SECONDS);
  const [recordedFile,setRecordedFile]=useState<File|null>(null);
  const [recordedUrl,setRecordedUrl]=useState("");
  const [downloadNote,setDownloadNote]=useState("");
  const [micError,setMicError]=useState("");
  const [taps,setTaps]=useState<number[]>([]);
  const [result,setResult]=useState<PromptPair|null>(null);
  const [history,setHistory]=useState<PromptPair[]>([]);
  const [copied,setCopied]=useState("");
  const fileRef=useRef<HTMLInputElement>(null);
  const recorderRef=useRef<MediaRecorder|null>(null);
  const streamRef=useRef<MediaStream|null>(null);
  const recordingChunksRef=useRef<Blob[]>([]);
  const recordingIntervalRef=useRef<number|null>(null);
  const recordingTimeoutRef=useRef<number|null>(null);
  const recordingStartedAtRef=useRef(0);

  useEffect(()=>{
    try { setHistory(JSON.parse(localStorage.getItem("fable-history") || "[]")); } catch {}
    setRecordingSupported(Boolean(navigator.mediaDevices && supportedRecordingType()));
    return ()=>{
      if(recordingIntervalRef.current!==null) window.clearInterval(recordingIntervalRef.current);
      if(recordingTimeoutRef.current!==null) window.clearTimeout(recordingTimeoutRef.current);
      streamRef.current?.getTracks().forEach(track=>track.stop());
    };
  },[]);
  useEffect(()=>()=>{ if(recordedUrl) URL.revokeObjectURL(recordedUrl); },[recordedUrl]);
  const baseOptions=useMemo(()=>genresData.filter(g=>g.role==="base"||g.role==="both"),[]);
  const dropOptions=useMemo(()=>genresData.filter(g=>g.role==="drop"||g.role==="both"),[]);
  const selected=useMemo(()=>[genresData.find(g=>g.name===base),genresData.find(g=>g.name===drop)].filter(Boolean) as Genre[],[base,drop]);
  const inst=instrumentsData.find(i=>i.name===instrument) as Instrument;
  const culture=inst?.culture || "None";
  const moodObj=moodsData.find(m=>m.name===mood) || moodsData[0];
  const warnings=useMemo(()=>{
    const out:string[]=[];
    const a=selected[0],b=selected[1];
    if(a&&b){
      if(a.role==="base"&&b.role==="base") out.push("Two base genres may compete for the arrangement. Treat the second as a texture.");
      const gap=Math.max(a.bpmRange[0],b.bpmRange[0])-Math.min(a.bpmRange[1],b.bpmRange[1]);
      if(gap>20) out.push(`BPM ranges clash by ${gap} BPM. The engine will split the difference.`);
      if(badPairs.some(p=>p.includes(a.name)&&p.includes(b.name)) || a.incompatibleWith.includes(b.name) || b.incompatibleWith.includes(a.name)) out.push("Known volatile pairing: generate freely, but expect Suno to favor one genre.");
    }
    return out;
  },[selected]);
  const halftimeHint=selected.some(g=>g.halftime && detected && detected>=g.bpmRange[0]/2-8 && detected<=g.bpmRange[1]/2+8);

  function tapTempo(){
    const now=performance.now();
    let next=taps.length && now-taps[taps.length-1]<2500 ? [...taps,now].slice(-9) : [now];
    setTaps(next);
    if(next.length>1){ const intervals=next.slice(1).map((x,i)=>x-next[i]); const v=Math.round(60000/(intervals.reduce((a,b)=>a+b,0)/intervals.length)); setDetected(v); setBpm(nearestRange(v,selected)); }
  }

  async function analyze(file:File){
    setAnalyzing(true); setAnalysisError(""); setDetectedKey(null);
    try{
      const ctx=new AudioContext();
      const buffer=await ctx.decodeAudioData(await file.arrayBuffer());
      try{
        const { guess }=await import("web-audio-beat-detector");
        const beat=await guess(buffer); const tempo=Math.round(beat.bpm); setDetected(tempo); setBpm(nearestRange(tempo,selected));
      }catch{
        try{ const tempo=estimateBpm(buffer.getChannelData(0),buffer.sampleRate); setDetected(tempo); setBpm(nearestRange(tempo,selected)); }
        catch{ setAnalysisError("Beat detection was uncertain—tap the pulse below for a more reliable BPM."); }
      }
      try{
        const Pitchfinder=await import("pitchfinder");
        const detector=Pitchfinder.YIN({sampleRate:buffer.sampleRate,threshold:.12});
        const data=buffer.getChannelData(0), frame=2048, hist=Array(12).fill(0);
        for(let i=0;i+frame<data.length;i+=1024){ const f=detector(data.slice(i,i+frame)) || yinPitch(data.slice(i,i+frame),buffer.sampleRate); if(f&&f>50&&f<1600){ const midi=Math.round(69+12*Math.log2(f/440)); hist[((midi%12)+12)%12]++; } }
        const scores:{name:string,score:number}[]=[];
        for(let r=0;r<12;r++){ scores.push({name:`${PC_NAMES[r]} major`,score:pearson(hist,rotate(majorProfile,12-r))}); scores.push({name:`${PC_NAMES[r]} minor`,score:pearson(hist,rotate(minorProfile,12-r))}); }
        scores.sort((a,b)=>b.score-a.score);
        const confidence=clamp((scores[0].score+1)/2,0,1);
        if(confidence>=KEY_CONFIDENCE_THRESHOLD) setDetectedKey(scores[0].name);
      }catch{ /* Key detection is intentionally best-effort and silent. */ }
      await ctx.close();
    }catch{ setAnalysisError("This audio could not be decoded in your browser. Try WAV, or use Tap Tempo for BPM."); }
    finally{ setAnalyzing(false); }
  }

  function stopRecording(){
    if(recorderRef.current?.state==="recording") recorderRef.current.stop();
  }

  function clearRecordingTimers(){
    if(recordingIntervalRef.current!==null) window.clearInterval(recordingIntervalRef.current);
    if(recordingTimeoutRef.current!==null) window.clearTimeout(recordingTimeoutRef.current);
    recordingIntervalRef.current=null;
    recordingTimeoutRef.current=null;
  }

  function discardRecording(){
    if(recordedUrl) URL.revokeObjectURL(recordedUrl);
    setRecordedUrl("");
    setRecordedFile(null);
    setDownloadNote("");
    setRecordingRemaining(MAX_RECORDING_SECONDS);
  }

  async function startRecording(){
    const mimeType=supportedRecordingType();
    if(!mimeType || !navigator.mediaDevices?.getUserMedia) return;
    discardRecording();
    setMicError("");
    setAnalysisError("");
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      streamRef.current=stream;
      recordingChunksRef.current=[];
      const recorder=new MediaRecorder(stream,{mimeType});
      recorderRef.current=recorder;
      recorder.ondataavailable=event=>{ if(event.data.size) recordingChunksRef.current.push(event.data); };
      recorder.onerror=()=>setMicError("Recording stopped unexpectedly — you can still upload a file instead.");
      recorder.onstop=()=>{
        clearRecordingTimers();
        streamRef.current?.getTracks().forEach(track=>track.stop());
        streamRef.current=null;
        setIsRecording(false);
        const rawType=recorder.mimeType || mimeType;
        const blob=new Blob(recordingChunksRef.current,{type:rawType});
        if(!blob.size){
          setMicError("No audio was captured — please try again or upload a file instead.");
          return;
        }
        const extension=rawAudioExtension(rawType);
        const file=new File([blob],`fable-forge-${new Date().toISOString().replace(/[:.]/g,"-")}.${extension}`,{type:rawType});
        setRecordedFile(file);
        setRecordedUrl(URL.createObjectURL(blob));
      };
      recorder.start(250);
      setIsRecording(true);
      setRecordingRemaining(MAX_RECORDING_SECONDS);
      recordingStartedAtRef.current=performance.now();
      recordingIntervalRef.current=window.setInterval(()=>{
        const elapsed=(performance.now()-recordingStartedAtRef.current)/1000;
        setRecordingRemaining(Math.max(0,MAX_RECORDING_SECONDS-elapsed));
      },100);
      recordingTimeoutRef.current=window.setTimeout(stopRecording,MAX_RECORDING_SECONDS*1000);
    }catch{
      streamRef.current?.getTracks().forEach(track=>track.stop());
      streamRef.current=null;
      clearRecordingTimers();
      setIsRecording(false);
      setMicError("Microphone access is needed to record — you can still upload a file instead");
    }
  }

  async function downloadRecording(){
    if(!recordedFile) return;
    setDownloadNote("");
    let downloadBlob:Blob=recordedFile;
    let downloadName="recording.wav";
    let context:AudioContext|null=null;
    try{
      context=new AudioContext();
      const decoded=await context.decodeAudioData(await recordedFile.arrayBuffer());
      downloadBlob=encodeWav(decoded);
    }catch{
      downloadName=recordedFile.name;
      setDownloadNote("Downloaded in original format — WAV conversion unavailable in this browser.");
    }finally{
      if(context) await context.close().catch(()=>{});
    }
    const url=URL.createObjectURL(downloadBlob);
    const link=document.createElement("a");
    link.href=url;
    link.download=downloadName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(()=>URL.revokeObjectURL(url),0);
  }

  function randomize(chaos=false){
    let bg:string, dg:string, ins:string;
    if(chaos && Math.random()<0.72){ const pair=pick(uncharted); bg=pair[0]; dg=pick(dropOptions.filter(g=>g.name!==bg)).name; ins=pair[1]; }
    else { bg=pick(baseOptions).name; const viable=dropOptions.filter(g=>g.name!==bg && !badPairs.some(p=>p.includes(bg)&&p.includes(g.name))); dg=pick(viable).name; ins=pick(instrumentsData.slice(1)).name; }
    setBase(bg); setDrop(dg); setInstrument(ins); setMood(pick(moodsData).name);
    const gs=[genresData.find(g=>g.name===bg)!,genresData.find(g=>g.name===dg)!]; setBpm(nearestRange(gs[0].bpmRange[0]+Math.random()*(gs[0].bpmRange[1]-gs[0].bpmRange[0]),gs));
  }

  function assemble(){
    const scene=pick(moodObj.sceneBank), adjectives=[...moodObj.adjectives].sort(()=>Math.random()-.5).slice(0,4);
    const gs=selected.map(g=>`${g.name.toLowerCase()} (${pick(g.keywords)})`).join(", ");
    const shoutObj=shoutsData.find(s=>s.culture===culture), shout=shoutObj?pick(shoutObj.words):"Hey!";
    const slots=[instrumental?"instrumental":null,gs,`${inst.name} — ${inst.fallbackDescription}`,inst.drum?`${inst.name} fused with 808 as one single impact sound`:null,scene,"dramatic silence before drops",shouts?`${shout} — short shouts as percussive hype accents, not sung lyrics`:null,`${bpm} BPM${selected.some(g=>g.halftime)?" halftime":""}`,detectedKey?`in ${detectedKey}`:null,adjectives.join(", "),instrumental?"no vocals":null].filter(Boolean);
    const style=slots.join(", ") + ".";
    const st=(selected[1]||selected[0]).structureType;
    const scenes=Array.from({length:8},()=>pick(moodObj.sceneBank));
    const shoutTag=shouts?` — ${shout}`:"";
    const tags=st==="drop-arc"?["Intro","Verse","Build","Drop","Breakdown","Build","Drop","Outro"]:st==="chorus-arc"?["Intro","Verse","Pre-Chorus","Chorus","Verse","Chorus","Bridge","Final Chorus","Outro"]:["Pulse","Layer 1","Layer 2","Build","Full Assembly","Reset","Final Assembly","Dissolve"];
    const lyrics=tags.map((t,i)=>`[${t}${(t.includes("Build")||t.includes("Drop")||t.includes("Assembly"))?shoutTag:""}]\n${scenes[i%scenes.length]}`).join("\n\n");
    const pair={id:Date.now(),style,lyrics,meta:`${base} × ${drop} · ${bpm} BPM${detectedKey?` · ${detectedKey}`:""}`,detectedKey:detectedKey || undefined};
    setResult(pair); const next=[pair,...history].slice(0,20); setHistory(next); localStorage.setItem("fable-history",JSON.stringify(next));
  }
  async function copy(text:string,label:string){ await navigator.clipboard.writeText(text); setCopied(label); setTimeout(()=>setCopied(""),1600); }
  function handleShouts(v:boolean){ setShouts(v); if(v) setInstrumental(false); }

  return <main>
    <header className="topbar"><div className="brand"><div className="brandMark">F</div><div><b>FABLE <em>FORGE</em></b><span>RULE-BASED SUNO PROMPT SYSTEM</span></div></div><div className="privacy"><LockKeyhole size={14}/> Audio never leaves your device.</div></header>
    <section className="hero">
      <div className="eyebrow"><span/>FABLE METHOD · LOCAL ENGINE</div>
      <h1>Forge the sound<br/><i>you can already hear.</i></h1>
      <p>Analyze a rough melody, fuse genres with cultural instruments, and assemble a production-ready Suno prompt—without sending a single byte away.</p>
      <div className="stats"><span><b>50</b> GENRES</span><span><b>17</b> INSTRUMENTS</span><span><b>0</b> API CALLS</span></div>
    </section>

    <nav className="modeTabs" aria-label="Generation mode">
      <button className={mode==="standard"?"active":""} onClick={()=>setMode("standard")}><Music2 size={17}/> Standard <small>Manual control</small></button>
      <button className={mode==="surprise"?"active":""} onClick={()=>{setMode("surprise");randomize(false)}}><WandSparkles size={17}/> Surprise Me <small>Smart random</small></button>
      <button className={mode==="chaos"?"active":""} onClick={()=>{setMode("chaos");randomize(true)}}><FlaskConical size={17}/> Chaos Lab <small>Uncharted fusions</small></button>
    </nav>

    <div className="workspace">
      <div className="controls">
        <section className="panel analyzer">
          <div className="panelTitle"><span>01</span><div><h2>Audio Analyzer</h2><p>Drop a melody or tap the pulse.</p></div><Mic2 size={20}/></div>
          <div className="audioActions">
            <button className="dropzone" onClick={()=>fileRef.current?.click()}><Upload size={26}/><b>{analyzing?"Listening…":"Upload audio"}</b><span>MP3 · WAV · M4A</span></button>
            {recordingSupported&&<button className="recordButton" onClick={isRecording?stopRecording:startRecording} aria-label={isRecording?"Stop recording":"Record audio from your microphone"}><span className="recordDot"/>{isRecording?"Stop":"🎙️ Record"}</button>}
          </div>
          <input ref={fileRef} hidden type="file" accept="audio/*,.m4a" onChange={e=>e.target.files?.[0]&&analyze(e.target.files[0])}/>
          {recordingSupported===false&&<p className="supportNote">Recording isn’t supported in this browser. You can still upload an audio file.</p>}
          {isRecording&&<div className="recordingCard" aria-live="polite">
            <div className="progressRing" style={{background:`conic-gradient(var(--pink) ${((MAX_RECORDING_SECONDS-recordingRemaining)/MAX_RECORDING_SECONDS)*360}deg,#263248 0deg)`}}><div><strong>{Math.ceil(recordingRemaining)}</strong><span>SEC</span></div></div>
            <div><b>Recording your melody…</b><p>Stops automatically at 60 seconds.</p></div>
            <button onClick={stopRecording}>■ Stop</button>
          </div>}
          {recordedFile&&recordedUrl&&<div className="recordingReview">
            <div><b>Recording ready</b><span>Listen back before using it.</span></div>
            <audio controls src={recordedUrl}/>
            <div className="recordingReviewActions">
              <button onClick={startRecording}>🔄 Re-record</button>
              <button onClick={downloadRecording}>⬇️ Download WAV</button>
              <button className="acceptRecording" disabled={analyzing} onClick={()=>analyze(recordedFile)}>{analyzing?"Analyzing…":"✓ Use recording"}</button>
            </div>
            {downloadNote&&<p className="supportNote" role="status">{downloadNote}</p>}
          </div>}
          {micError&&<div className="notice">{micError}</div>}
          {analysisError&&<div className="notice">{analysisError}</div>}
          <div className="tempoGrid"><button className="tap" onClick={tapTempo}><Gauge size={22}/><b>TAP TEMPO</b><span>{taps.length?`${Math.min(taps.length,9)-1}/8 intervals`:"Tap at least twice"}</span></button><div className="bpmRead"><label>BPM</label><strong>{bpm}</strong><div><button onClick={()=>setBpm(Math.round(bpm/2))}>÷2</button><button onClick={()=>setBpm(bpm*2)}>×2</button></div></div></div>
          {halftimeHint&&<div className="hint">140 halftime feels like 70 — try ×2.</div>}
        </section>

        <section className="panel">
          <div className="panelTitle"><span>02</span><div><h2>Genre Math</h2><p>One foundation. One drop identity.</p></div></div>
          <div className="twoCol"><label>BASE GENRE<select value={base} onChange={e=>setBase(e.target.value)}>{baseOptions.map(g=><option key={g.name}>{g.name}</option>)}</select></label><label>DROP GENRE<select value={drop} onChange={e=>setDrop(e.target.value)}>{dropOptions.map(g=><option key={g.name}>{g.name}</option>)}</select></label></div>
          <div className="rangeViz"><div style={{left:`${Math.min(90,(selected[0].bpmRange[0]-60)/1.3)}%`,width:`${Math.max(7,(selected[0].bpmRange[1]-selected[0].bpmRange[0])/1.3)}%`}}/><div style={{left:`${Math.min(90,(selected[1].bpmRange[0]-60)/1.3)}%`,width:`${Math.max(7,(selected[1].bpmRange[1]-selected[1].bpmRange[0])/1.3)}%`}}/></div>
          {warnings.map(w=><div className="warning" key={w}>⚠ {w}</div>)}
        </section>

        <section className="panel">
          <div className="panelTitle"><span>03</span><div><h2>Culture & Intent</h2><p>Give the fusion a voice and a scene.</p></div></div>
          <div className="twoCol"><label>LEAD / PERCUSSION<select value={instrument} onChange={e=>setInstrument(e.target.value)}>{instrumentsData.map(i=><option key={i.name}>{i.name}</option>)}</select></label><label>MOOD<select value={mood} onChange={e=>setMood(e.target.value)}>{moodsData.map(m=><option key={m.name}>{m.name}</option>)}</select></label></div>
          <div className="toggles"><label><input type="checkbox" checked={instrumental} onChange={e=>setInstrumental(e.target.checked)}/><span/> Instrumental</label><label><input type="checkbox" checked={shouts} onChange={e=>handleShouts(e.target.checked)}/><span/> Percussive shouts</label></div>
          {instrumental&&<div className="chip">Remember: switch on Suno’s Instrumental toggle.</div>}
        </section>
        <button className="generate" onClick={assemble}><WandSparkles size={20}/> ASSEMBLE PROMPT <span>⌘ ↵</span></button>
      </div>

      <aside className="output panel">
        <div className="panelTitle"><span>04</span><div><h2>Forge Output</h2><p>Built in exact FABLE slot order.</p></div><div className="liveDot">LIVE</div></div>
        {!result?<div className="empty"><div className="orb"><Music2/></div><h3>Your prompt will assemble here.</h3><p>Choose your ingredients, then light the forge.</p><div className="ghostLines"><i/><i/><i/></div></div>:<div className="assembled" key={result.id}>
          {result.detectedKey&&<div className="detectedKeyBadge">Detected key: {result.detectedKey}</div>}
          <div className="boxHead"><label>STYLE PROMPT</label><button onClick={()=>copy(result.style,"style")}><Copy size={14}/>{copied==="style"?"COPIED":"COPY"}</button></div>
          <div className="promptBox styleBox">{result.style.split(", ").map((line,i)=><span key={i} style={{animationDelay:`${i*.055}s`}}>{line}{i<result.style.split(", ").length-1?", ":""}</span>)}</div>
          <div className="boxHead"><label>LYRICS FIELD</label><button onClick={()=>copy(result.lyrics,"lyrics")}><Copy size={14}/>{copied==="lyrics"?"COPIED":"COPY"}</button></div>
          <pre className="promptBox lyricsBox">{result.lyrics}</pre>
          <button className="suno" onClick={()=>{navigator.clipboard.writeText(result.style);window.open("https://suno.com/create","_blank","noopener,noreferrer")}}>COPY STYLE & OPEN SUNO <ExternalLink size={17}/></button>
          <p className="tooltip">Suno has no URL prefill—paste the copied prompt manually.</p>
        </div>}
      </aside>
    </div>

    <section className="history panel"><div className="panelTitle"><History size={19}/><div><h2>Recent Forges</h2><p>Stored only in this browser · last 20 prompt pairs</p></div>{history.length>0&&<button className="clear" onClick={()=>{setHistory([]);localStorage.removeItem("fable-history")}}><RotateCcw size={14}/> Clear</button>}</div>{!history.length?<p className="historyEmpty">No sparks yet. Your generated pairs will appear here.</p>:<div className="historyList">{history.map(h=><article key={h.id}><div><b>{h.meta}</b><p>{h.style}</p></div><button onClick={()=>copy(h.style,`h${h.id}`)}><Copy size={15}/>{copied===`h${h.id}`?"Copied":"Re-copy"}</button></article>)}</div>}</section>
    <footer>FABLE FORGE <span>·</span> CONCEPT FIRST <span>·</span> GENRE MATH <span>·</span> CULTURE WITH INTENT</footer>
  </main>;
}
