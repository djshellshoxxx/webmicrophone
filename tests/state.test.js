import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultSettings,validateSettings,parsePreset,presetDocument,SCENES,applyScene} from '../src/state.js';
import {detectPitch,correlation,measure} from '../src/analysis.js';

test('all scene presets validate and environmental presets keep speech enhancement off',()=>{
  for(const scene of SCENES) {
    const settings=applyScene(defaultSettings(),scene.id);
    assert.equal(settings.eq.length,10);
    if(!scene.id.startsWith('voice') && scene.id!=='street-voice') assert.equal(settings.speech,false);
  }
});
test('portable settings do not import session permissions, monitoring or device identifiers',()=>{
  const input={...defaultSettings(),monitorEnabled:true,deviceId:'device',constructor:{polluted:true}};
  const parsed=parsePreset(JSON.stringify(presetDocument('My mic',input)));
  assert.equal(parsed.settings.monitorEnabled,undefined);
  assert.equal(parsed.settings.deviceId,undefined);
  assert.equal(Object.hasOwn(parsed.settings,'constructor'),false);
});
test('reject malformed, future, non-finite and excessive settings',()=>{
  assert.throws(()=>validateSettings({...defaultSettings(),schemaVersion:999}));
  assert.throws(()=>validateSettings({...defaultSettings(),inputGainDb:Infinity}));
  assert.throws(()=>validateSettings({...defaultSettings(),eq:[]}));
  assert.throws(()=>parsePreset('x'.repeat(150000)));
  assert.throws(()=>validateSettings({...defaultSettings(),highpassHz:1800,lowpassHz:1000}));
});
test('tuner detects A4, C3 and rejects silence',()=>{
  for(const [hz,note] of [[440,'A4'],[130.8128,'C3']]){
    const data=Float32Array.from({length:4096},(_,i)=>0.25*Math.sin(2*Math.PI*hz*i/48000));
    const pitch=detectPitch(data,48000);
    assert.equal(pitch.note,note);
    assert.ok(Math.abs(pitch.cents)<2);
  }
  assert.equal(detectPitch(new Float32Array(4096),48000),null);
});
test('correlation distinguishes polarity and level meter sees clipping',()=>{
  const l=Float32Array.from([.4,-.2,.8,-.6]);
  assert.ok(Math.abs(correlation(l,l)-1)<1e-9);
  assert.ok(Math.abs(correlation(l,l.map(x=>-x))+1)<1e-9);
  assert.equal(correlation(new Float32Array(4),new Float32Array(4)),null);
  assert.equal(measure(Float32Array.from([0,1,-1])).clipped,2);
});
