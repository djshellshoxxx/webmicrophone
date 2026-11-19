import {SCENES,MICROPHONES,applyScene,defaultSettings,savePreset,savedPresets,presetDocument,parsePreset,renamePreset,deletePreset} from './state.js';

export function downloadBlob(blob, name) {
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');
  link.href=url; link.download=name; document.body.append(link); link.click(); link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
export function safeName(name) { return String(name||'webmicrophone').replace(/\.[^.]+$/,'').replace(/[^a-z0-9_ -]/gi,'-').slice(0,80)||'webmicrophone'; }

export function bindSettings({getSettings,onChange,notify}) {
  const byId=id=>document.getElementById(id);
  const controls=[...document.querySelectorAll('[data-setting]')];
  const appendOptions=(select,entries)=>{
    for(const item of entries){const option=document.createElement('option');option.value=item.id;option.textContent=item.name;select.append(option);}
  };
  appendOptions(byId('scene'),SCENES); appendOptions(byId('microphone-profile'),MICROPHONES);
  const customOption=document.createElement('option');customOption.value='custom';customOption.textContent='Custom settings';customOption.disabled=true;byId('scene').append(customOption);
  for(const control of controls){
    control.addEventListener(control.type==='range'?'input':'change',()=>{
      const next=structuredClone(getSettings());
      next[control.dataset.setting]=control.type==='checkbox'?control.checked:Number(control.value);
      next.scene='custom';
      try{onChange(next);}catch(error){notify(error.message,true);sync();}
    });
  }
  byId('scene').addEventListener('change',()=>{
    onChange(applyScene(getSettings(),byId('scene').value));
    notify('Situation loaded. You can refine the filters and compare the original.');
  });
  byId('microphone-profile').addEventListener('change',()=>{
    const profile=MICROPHONES.find(item=>item.id===byId('microphone-profile').value);
    onChange({...getSettings(),scene:'custom',microphoneProfile:profile.id,highpassHz:profile.highpass});
    notify('Microphone starting point applied. Channel preference is used on the next connection.');
  });
  function refreshSaved(){
    const select=byId('saved-preset');select.replaceChildren();
    const first=document.createElement('option');first.value='';first.textContent='Choose saved settings…';select.append(first);
    savedPresets().forEach((preset,index)=>{const option=document.createElement('option');option.value=String(index);option.textContent=preset.name;select.append(option);});
    byId('rename-preset').disabled=byId('delete-preset').disabled=true;
  }
  byId('save-preset').addEventListener('click',()=>{
    try{savePreset(byId('preset-name').value,getSettings());refreshSaved();byId('saved-preset').value='0';byId('rename-preset').disabled=byId('delete-preset').disabled=false;notify('Settings saved in this browser. You can also download a portable JSON copy.');}
    catch(error){notify(error.message,true);}
  });
  byId('saved-preset').addEventListener('change',()=>{
    byId('rename-preset').disabled=byId('delete-preset').disabled=byId('saved-preset').value==='';
    if(byId('saved-preset').value==='')return;
    const preset=savedPresets()[Number(byId('saved-preset').value)];
    if(preset){onChange(preset.settings);byId('preset-name').value=preset.name;notify('Loaded '+preset.name+'. Monitoring has not changed.');}
  });
  byId('rename-preset').addEventListener('click',()=>{
    try{
      const index=Number(byId('saved-preset').value),selected=savedPresets()[index];
      if(byId('saved-preset').value===''||!selected)throw new Error('Choose saved settings to rename first.');
      const name=renamePreset(selected.name,byId('preset-name').value);refreshSaved();byId('saved-preset').value=String(index);byId('rename-preset').disabled=byId('delete-preset').disabled=false;notify('Saved preset renamed to '+name+'.');
    }catch(error){notify(error.message,true);}
  });
  byId('delete-preset').addEventListener('click',()=>{
    try{
      const selected=savedPresets()[Number(byId('saved-preset').value)];
      if(byId('saved-preset').value===''||!selected)throw new Error('Choose saved settings to delete first.');
      if(!confirm('Delete saved settings “'+selected.name+'”? Your audio recordings and current processing will stay available.'))return;
      deletePreset(selected.name);refreshSaved();notify('Saved preset deleted. Current processing is still available to save again.');
    }catch(error){notify(error.message,true);}
  });
  byId('export-preset').addEventListener('click',()=>{
    const doc=presetDocument(byId('preset-name').value,getSettings());
    downloadBlob(new Blob([JSON.stringify(doc,null,2)],{type:'application/json'}),safeName(doc.name)+'.webmicrophone.json');
    notify('Portable settings downloaded.');
  });
  byId('import-preset').addEventListener('click',()=>byId('preset-file').click());
  byId('preset-file').addEventListener('change',async()=>{
    const file=byId('preset-file').files[0];if(!file)return;
    try{if(file.size>128*1024)throw new Error('Preset files must be smaller than 128 KB.');const preset=parsePreset(await file.text());onChange(preset.settings);byId('preset-name').value=preset.name;notify('Imported '+preset.name+'. Save it here to keep it in this browser.');}
    catch(error){notify(error.message,true);}finally{byId('preset-file').value='';}
  });
  byId('reset-settings').addEventListener('click',()=>{onChange(defaultSettings());notify('Processing reset. Source recordings are unchanged.');});
  function sync(){
    const settings=getSettings();
    for(const control of controls){
      const value=settings[control.dataset.setting];
      if(control.type==='checkbox')control.checked=Boolean(value);else control.value=String(value);
    }
    for(const out of document.querySelectorAll('[data-value]')){
      const key=out.dataset.value;const value=settings[key];
      out.textContent=['mix','denoise'].includes(key)?Math.round(value*100)+'%':key.endsWith('Ms')?value.toFixed(1)+' ms':value.toFixed(1)+' dB';
    }
    byId('scene').value=SCENES.some(item=>item.id===settings.scene)?settings.scene:'custom';
    byId('microphone-profile').value=MICROPHONES.some(item=>item.id===settings.microphoneProfile)?settings.microphoneProfile:'neutral';
    byId('scene-description').textContent=SCENES.find(item=>item.id===settings.scene)?.description||'Your current processing settings. Choose a situation to load a new starting point.';
    byId('microphone-advice').textContent=(MICROPHONES.find(item=>item.id===settings.microphoneProfile)||MICROPHONES[0]).description;
    byId('noise-status').textContent=settings.noiseProfile?'Noise profile ready · fixed 1,024-point spectrum':'No learned profile. Reduction passes through.';
  }
  refreshSaved();sync();return {sync,refreshSaved};
}
