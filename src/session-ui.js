import {listTakes,loadTake,deleteTake,importAudioFile,getOriginalFile} from './recording/recorder.js';
import {encodeWav,exportCompressed,getCompressedFormats,renderProcessed,prepareExportBuffer} from './export/index.js';
import {downloadBlob,safeName} from './settings-ui.js';
import {formatTime} from './analysis.js';

export class SessionUI {
  constructor({state,ensureAudio,stopLive,notify,onSourceChange,onBusyChange=()=>{}}){
    Object.assign(this,{state,ensureAudio,stopLive,notify,onSourceChange,onBusyChange});
    this.id=id=>document.getElementById(id);
    this.formats=getCompressedFormats();
    for(const format of this.formats){const option=document.createElement('option');option.value=format.id;option.textContent=format.label;this.id('export-format').append(option);}
    this.id('open-audio').onclick=()=>this.id('audio-file').click();
    this.id('audio-file').onchange=()=>this.run(()=>this.importFile());
    this.id('refresh-takes').onclick=()=>this.run(()=>this.refresh());
    this.id('play-clip').onclick=()=>this.run(()=>this.play());
    this.id('stop-playback').onclick=()=>this.stopPlayback();
    this.id('audition-mode').onchange=()=>this.setAudition();
    this.id('loop').onchange=()=>this.run(async()=>{
      if(!this.playback)return;
      try{this.requireIdle();}catch(error){this.id('loop').checked=this.playback.loop;throw error;}
      // A duration scheduled in start() cannot be removed by setting loop=true.
      // Restart the selection so both enabling and disabling looping are exact.
      this.stopPlayback();
      await this.play();
    });
    this.id('trim-start').onchange=this.id('trim-end').onchange=()=>this.drawClip();
    this.id('export-format').onchange=()=>{
      const wav=this.id('export-format').value.startsWith('wav');
      this.id('bitrate-field').hidden=wav;
      this.id('export-note').textContent=wav?'WAV bitrate is sample rate × bit depth × channels. The selected rate is written into the exported WAV.':'Compressed bitrate is a target. The sample rate prepares the audio for encoding; the browser codec may choose a different final rate or bitrate. Compressed export runs in real time.';
    };
    this.id('export-audio').onclick=()=>this.run(()=>this.exportAudio());
    this.id('cancel-export').onclick=()=>this.abortController?.abort();
    this.id('download-original').onclick=()=>this.run(()=>this.downloadOriginal());
    this.resizeObserver=new ResizeObserver(()=>this.drawClip());this.resizeObserver.observe(this.id('clip-waveform'));
    this.refresh().catch(error=>this.notify(error.message,true));
  }
  async run(fn){try{await fn();}catch(error){this.notify(error.message||String(error),true);}}
  requireIdle(){
    if(this.state.recordingBusy)throw new Error('Stop and save the active recording before changing clips or exporting.');
    if(this.state.sessionBusy)throw new Error('Wait for the current audio operation to finish, or cancel the export.');
    if(this.abortController)throw new Error('Finish or cancel the current export first.');
  }
  setBusy(value){this.state.sessionBusy=value;this.onBusyChange(value);}
  async refresh(){
    const takes=await listTakes();const container=this.id('takes-list');container.replaceChildren();
    if(!takes.length){const empty=document.createElement('p');empty.className='empty-state';empty.textContent='Record a take or open audio to start. Original and filtered recordings will appear here.';container.append(empty);return;}
    for(const take of takes){
      const row=document.createElement('div');row.className='take-row'+(this.activeTake?.id===take.id?' active':'');
      const button=document.createElement('button');button.className='take-select';
      const name=document.createElement('span');name.textContent=take.label||'Untitled take';
      const detail=document.createElement('small');detail.textContent=formatTime(take.duration)+' · '+take.channels+' ch · '+(take.status==='complete'?'saved':take.status)+' · '+(take.storageMode==='memory'?'session only':'local');
      button.append(name,detail);button.onclick=()=>this.run(()=>this.selectTake(take.id));
      const remove=document.createElement('button');remove.className='delete-take';remove.textContent='Delete';remove.setAttribute('aria-label','Delete '+take.label);
      remove.onclick=()=>this.run(async()=>{
        this.requireIdle();
        if(!confirm('Delete this local take? Download an original first if you want to keep it.'))return;
        await deleteTake(take.id);
        if(this.activeTake?.id===take.id){this.stopPlayback();this.activeTake=null;this.buffer=null;this.originalFile=null;this.syncClip();}
        await this.refresh();
      });
      row.append(button,remove);container.append(row);
    }
  }
  async selectTake(id){
    this.requireIdle();
    this.setBusy(true);
    try{
      await this.stopLive();this.stopPlayback();const context=await this.ensureAudio();
      const result=await loadTake(id,{track:'raw',context});
      this.setClip(result.buffer,result.metadata);
      this.notify('Loaded '+result.metadata.label+'. Rendering starts from its original capture.');
      await this.refresh();
    }finally{this.setBusy(false);}
  }
  async importFile(){
    this.requireIdle();
    const file=this.id('audio-file').files[0];if(!file)return;
    this.setBusy(true);
    try{
      await this.stopLive();this.stopPlayback();const context=await this.ensureAudio();
      this.notify('Opening '+file.name+' locally…');
      const result=await importAudioFile(file,context);
      this.setClip(result.buffer,result.metadata,result.originalFile||{blob:file,filename:file.name});
      await this.refresh();this.notify(result.metadata.message||'Audio opened. Adjust processing, audition a selection, then render a new file.');
    }finally{this.id('audio-file').value='';this.setBusy(false);}
  }
  setClip(buffer,metadata,originalFile=null){
    this.buffer=buffer;this.activeTake=metadata;this.originalFile=originalFile;
    // Cache true extrema once. Sparse sampling can hide short impacts such as
    // hail, clicks and clipping when a long recording is fitted into one panel.
    const bins=Math.min(4096,buffer.length);
    const minimum=new Float32Array(bins),maximum=new Float32Array(bins);
    minimum.fill(Infinity);maximum.fill(-Infinity);
    for(let channel=0;channel<buffer.numberOfChannels;channel++){
      const samples=buffer.getChannelData(channel);
      for(let bin=0;bin<bins;bin++){
        const start=Math.floor(bin*samples.length/bins),end=Math.floor((bin+1)*samples.length/bins);
        let low=minimum[bin],high=maximum[bin];
        for(let i=start;i<end;i++){const value=Number.isFinite(samples[i])?samples[i]:0;if(value<low)low=value;if(value>high)high=value;}
        minimum[bin]=low;maximum[bin]=high;
      }
    }
    this.overview={minimum,maximum};
    this.id('trim-start').value='0';this.id('trim-end').value=String(buffer.duration);
    this.syncClip();this.onSourceChange('clip');
  }
  syncClip(){
    this.id('clip-title').textContent=this.buffer?(this.activeTake?.label||'Audio clip'):'No clip selected';
    for(const id of ['play-clip','export-audio','download-original'])this.id(id).disabled=!this.buffer;
    this.id('export-status').textContent=this.buffer?formatTime(this.buffer.duration)+' · '+this.buffer.numberOfChannels+' channels · '+this.buffer.sampleRate+' Hz working audio':'Select a take or open an audio file.';
    this.id('export-source').querySelector('option[value=recorded]').disabled=!this.activeTake?.processedAvailable;
    if(!this.activeTake?.processedAvailable&&this.id('export-source').value==='recorded')this.id('export-source').value='current';
    const hasStoredId=Boolean(this.activeTake?.id);
    const sessionOnly=!hasStoredId||['memory','session'].includes(this.activeTake?.storageMode);
    this.id('storage-status').textContent=!hasStoredId&&this.activeTake?.sourceKind==='generated'
      ?'Generated signal · session only'
      :sessionOnly?'Session only · download before leaving':'Stored in this browser';
    this.drawClip();
  }
  trim(){
    const start=Number(this.id('trim-start').value),end=Number(this.id('trim-end').value);
    if(!this.buffer||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>this.buffer.duration+0.002)throw new Error('Choose a non-empty trim range inside the recording.');
    return {start,end:Math.min(end,this.buffer.duration)};
  }
  async play(){
    this.requireIdle();
    if(!this.buffer)throw new Error('Choose a recording first.');
    this.setBusy(true);
    try{
    await this.stopLive();this.stopPlayback();const context=await this.ensureAudio();await context.resume();
    const {start,end}=this.trim();const source=context.createBufferSource();source.buffer=this.buffer;
    source.connect(this.state.graph.input);source.loop=this.id('loop').checked;source.loopStart=start;source.loopEnd=end;
    this.playback=source;this.setAudition();this.state.auditionMaster.gain.setTargetAtTime(0.8,context.currentTime,0.01);
    source.onended=()=>{
      if(this.playback!==source)return;
      source.disconnect();
      // Let the aligned dry and wet paths drain before muting. All-pass/EQ
      // filter tails also get a short release rather than an abrupt cut.
      this.playbackEndTimer=setTimeout(()=>{
        if(this.playback!==source)return;
        this.playback=null;this.id('play-clip').disabled=false;this.id('stop-playback').disabled=true;
        this.state.auditionMaster.gain.setTargetAtTime(0,context.currentTime,0.01);this.onSourceChange('clip');
      },(this.state.graph.latencySamples/context.sampleRate+Math.abs(this.state.settings.channelDelayMs)/1000+0.15)*1000);
    };
    if(source.loop)source.start(0,start);else source.start(0,start,end-start);
    this.id('play-clip').disabled=true;this.id('stop-playback').disabled=false;
    this.onSourceChange('playback');this.notify('Playing selection. Microphone capture is off.');
    }finally{this.setBusy(false);}
  }
  setAudition(){
    if(!this.state.context)return;const time=this.state.context.currentTime;const mode=this.id('audition-mode').value;
    this.state.auditionDry.gain.setTargetAtTime(mode==='original'||mode==='difference'?1:0,time,0.01);
    this.state.auditionWet.gain.setTargetAtTime(mode==='processed'?1:mode==='difference'?-1:0,time,0.01);
  }
  stopPlayback(){
    clearTimeout(this.playbackEndTimer);
    if(this.playback){const node=this.playback;this.playback=null;node.onended=null;try{node.stop();}catch{}node.disconnect();}
    if(this.state.auditionMaster)this.state.auditionMaster.gain.value=0;
    this.id('play-clip').disabled=!this.buffer;this.id('stop-playback').disabled=true;
  }
  async downloadOriginal(){
    this.requireIdle();
    if(!this.buffer)return;
    this.setBusy(true);
    try{
    let original=this.originalFile;
    if(!original&&this.activeTake?.id)original=await getOriginalFile(this.activeTake.id);
    if(original){
      const blob=original.blob||original.file||original;
      downloadBlob(blob,original.filename||this.activeTake?.label||'original-audio');
    }else downloadBlob(await encodeWav(this.buffer,{bitDepth:'32float'}),safeName(this.activeTake?.label)+'-original.wav');
    this.notify('Original audio downloaded.');
    }finally{this.setBusy(false);}
  }
  async exportAudio(){
    this.requireIdle();
    if(!this.buffer)throw new Error('Choose a recording first.');
    const sourceBuffer=this.buffer,sourceTakeId=this.activeTake?.id,recordedAvailable=this.activeTake?.processedAvailable;
    const trim=this.trim();const settings=structuredClone(this.state.settings);const mode=this.id('export-source').value;
    const format=this.id('export-format').value,sampleRate=Number(this.id('export-rate').value),normalize=this.id('normalize').checked;
    const bitrateKbps=Number(this.id('export-bitrate').value);const baseName=safeName(this.activeTake?.label);
    this.abortController=new AbortController();const signal=this.abortController.signal;
    this.setBusy(true);
    const progress=this.id('export-progress');progress.hidden=false;this.id('cancel-export').hidden=false;this.id('export-audio').disabled=true;
    const onProgress=({phase,progress:value})=>{this.id('export-status').textContent=phase;if(value==null)progress.removeAttribute('value');else progress.value=value;};
    try{
      let buffer=sourceBuffer,exportTrim=trim;
      if(mode==='recorded'){
        if(!sourceTakeId||!recordedAvailable)throw new Error('This source has no live-filtered take. Choose current settings instead.');
        buffer=(await loadTake(sourceTakeId,{track:'processed',context:await this.ensureAudio()})).buffer;
      }else if(mode==='current'){
        onProgress({phase:'Preparing the selected region · processing starts at its beginning',progress:null});
        const selection=await prepareExportBuffer(sourceBuffer,{sampleRate:sourceBuffer.sampleRate,trim,normalize:false,signal,onProgress});
        buffer=await renderProcessed(selection,settings,{signal,onProgress});
        // The rendered buffer is already the selection: never apply the original
        // timeline a second time to the shorter result.
        exportTrim=undefined;
      }
      let blob,extension,encoderNote='';
      if(format.startsWith('wav')){
        const bitDepth=format==='wav32'?'32float':format==='wav24'?24:16;
        blob=await encodeWav(buffer,{bitDepth,sampleRate,normalize,trim:exportTrim,signal,onProgress});extension='wav';
      }else{
        const result=await exportCompressed(buffer,{format,bitrateKbps,sampleRate,normalize,trim:exportTrim,signal,onProgress});
        ({blob,extension}=result);encoderNote=' · encoder target '+Math.round((result.bitrate||result.requestedBitrate)/1000)+' kbps';
      }
      if(signal.aborted)throw new DOMException('Export cancelled','AbortError');
      const formatLabel=format.startsWith('wav')?sampleRate+'Hz':format;
      downloadBlob(blob,baseName+'-'+(mode==='current'?'filtered':mode)+'-'+formatLabel+'.'+extension);
      this.id('export-status').textContent='Downloaded · '+(blob.size/1024/1024).toFixed(2)+' MiB'+encoderNote+(mode==='current'?' · selection processed from its beginning':'');
      this.notify('Audio exported. The original recording remains available.');
    }catch(error){
      if(error.name==='AbortError'){this.id('export-status').textContent='Export cancelled. Original audio is unchanged.';this.notify('Export cancelled.');}
      else{this.id('export-status').textContent=error.message;throw error;}
    }finally{this.abortController=null;this.id('export-audio').disabled=!this.buffer;this.id('cancel-export').hidden=true;progress.hidden=true;this.setBusy(false);}
  }
  drawClip(){
    const canvas=this.id('clip-waveform');const width=Math.max(1,canvas.clientWidth),height=88;const ratio=Math.min(2,devicePixelRatio||1);
    canvas.width=width*ratio;canvas.height=height*ratio;const ctx=canvas.getContext('2d');ctx.scale(ratio,ratio);
    ctx.fillStyle='#11151b';ctx.fillRect(0,0,width,height);ctx.strokeStyle='#2a303a';ctx.beginPath();ctx.moveTo(0,height/2);ctx.lineTo(width,height/2);ctx.stroke();
    if(!this.buffer){ctx.fillStyle='#9ca5b2';ctx.font='11px system-ui';ctx.fillText('Select a take to inspect and trim',14,48);return;}
    const {minimum,maximum}=this.overview;
    ctx.strokeStyle='#4fb6c4';ctx.beginPath();
    for(let x=0;x<width;x++){let min=Infinity,max=-Infinity;const start=Math.floor(x*minimum.length/width),end=Math.min(minimum.length,Math.max(start+1,Math.ceil((x+1)*minimum.length/width)));for(let i=start;i<end;i++){min=Math.min(min,minimum[i]);max=Math.max(max,maximum[i]);}ctx.moveTo(x,height/2-max*height*.43);ctx.lineTo(x,height/2-min*height*.43);}
    ctx.stroke();const start=Number(this.id('trim-start').value)||0,end=Number(this.id('trim-end').value)||0;
    ctx.fillStyle='#e8532a1c';ctx.fillRect(start/this.buffer.duration*width,0,(end-start)/this.buffer.duration*width,height);
    ctx.strokeStyle='#e8532a';for(const t of [start,end]){const x=t/this.buffer.duration*width;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,height);ctx.stroke();}
  }
}
