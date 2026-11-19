export const SCHEMA_VERSION = 1;
export const EQ_FREQUENCIES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export function defaultSettings() {
  return {
    schemaVersion: 1, scene: 'natural', microphoneProfile: 'neutral',
    inputGainDb: 0, outputGainDb: 0, highpassHz: 20, lowpassHz: 20000,
    humHz: 0, speech: false, denoise: 0, noiseProfile: null,
    gateEnabled: false, gateThresholdDb: -55, gateReleaseMs: 150,
    compressorEnabled: false, compressorThresholdDb: -24, compressorRatio: 3,
    compressorAttackMs: 10, compressorReleaseMs: 150,
    eqEnabled: true,
    eq: EQ_FREQUENCIES.map(frequency => ({frequency, gain: 0, q: 1, type: 'peaking', enabled: true})),
    soloBand: -1, polarityL: false, polarityR: false, phaseEnabled: false,
    phaseFrequency: 1000, phaseQ: 0.707, channelDelayMs: 0,
    mono: false, mix: 1, limiterEnabled: true,
  };
}

const ranges = {
  inputGainDb: [-30, 24], outputGainDb: [-48, 12], highpassHz: [20, 2000],
  lowpassHz: [1000, 22000], denoise: [0, 1], gateThresholdDb: [-90, -6],
  gateReleaseMs: [20, 2000], compressorThresholdDb: [-60, 0],
  compressorRatio: [1, 20], compressorAttackMs: [0.1, 100],
  compressorReleaseMs: [20, 2000], phaseFrequency: [20, 20000],
  phaseQ: [0.1, 20], channelDelayMs: [-20, 20], mix: [0, 1],
};

function checkedNumber(value, range, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < range[0] || value > range[1]) {
    throw new Error(name + ' must be a number between ' + range[0] + ' and ' + range[1] + '.');
  }
  return value;
}

export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be a JSON object.');
  if (input.schemaVersion !== SCHEMA_VERSION) throw new Error('This settings version is not supported.');
  const result = defaultSettings();
  for (const [key, range] of Object.entries(ranges)) {
    if (key in input) result[key] = checkedNumber(input[key], range, key);
  }
  for (const key of Object.keys(result).filter(key => typeof result[key] === 'boolean')) {
    if (key in input) {
      if (typeof input[key] !== 'boolean') throw new Error(key + ' must be true or false.');
      result[key] = input[key];
    }
  }
  for (const key of ['scene', 'microphoneProfile']) {
    if (key in input && typeof input[key] === 'string' && /^[a-z0-9-]{1,48}$/.test(input[key])) result[key] = input[key];
  }
  if ('humHz' in input) {
    if (![0, 50, 60].includes(input.humHz)) throw new Error('Hum frequency must be off, 50 Hz or 60 Hz.');
    result.humHz = input.humHz;
  }
  if ('soloBand' in input) {
    if (!Number.isInteger(input.soloBand) || input.soloBand < -1 || input.soloBand > 9) throw new Error('Invalid solo band.');
    result.soloBand = input.soloBand;
  }
  if ('eq' in input) {
    if (!Array.isArray(input.eq) || input.eq.length !== 10) throw new Error('A preset must contain exactly ten EQ bands.');
    result.eq = input.eq.map((band, i) => {
      if (!band || typeof band !== 'object') throw new Error('Invalid EQ band ' + (i + 1) + '.');
      if (!['peaking', 'lowshelf', 'highshelf', 'notch', 'highpass', 'lowpass'].includes(band.type)) throw new Error('Unsupported EQ filter type.');
      if (typeof band.enabled !== 'boolean') throw new Error('Invalid EQ enabled setting.');
      return {
        frequency: checkedNumber(band.frequency, [20, 20000], 'Band frequency'),
        gain: checkedNumber(band.gain, [-18, 18], 'Band gain'),
        q: checkedNumber(band.q, [0.1, 20], 'Band Q'),
        type: band.type, enabled: band.enabled,
      };
    });
  }
  if (result.highpassHz >= result.lowpassHz) throw new Error('Low cut must be below high cut.');
  if (input.noiseProfile != null) result.noiseProfile = validateNoiseProfile(input.noiseProfile);
  return result;
}

export function validateNoiseProfile(profile) {
  if (!profile || typeof profile !== 'object' || profile.version !== 1 ||
      profile.sampleRate !== 48000 || profile.fftSize !== 1024 ||
      !Array.isArray(profile.power) || profile.power.length !== 513) {
    throw new Error('This noise profile is incompatible with the current processing engine.');
  }
  return {
    version: 1, sampleRate: 48000, fftSize: 1024,
    power: profile.power.map(value => checkedNumber(value, [0, 1e8], 'Noise profile power')),
  };
}

export function presetDocument(name, settings) {
  return {
    application: 'Circuit Drift Labs WebMicrophone', formatVersion: 1,
    name: String(name || 'My settings').slice(0, 80),
    createdAt: new Date().toISOString(),
    settings: validateSettings(settings),
  };
}

export function parsePreset(text) {
  if (typeof text !== 'string' || text.length > 128 * 1024) throw new Error('Preset files must be smaller than 128 KB.');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('This file is not valid JSON.'); }
  if (parsed.formatVersion !== 1 || typeof parsed.name !== 'string') throw new Error('This is not a WebMicrophone preset.');
  return {name: parsed.name.slice(0, 80), settings: validateSettings(parsed.settings)};
}

const PRESETS_KEY = 'cdl.webmicrophone.presets.v1';
export function savedPresets() {
  try {
    const documents = JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]');
    if (!Array.isArray(documents)) return [];
    return documents.slice(0, 40).flatMap(doc => {
      try { return [presetDocument(doc.name, validateSettings(doc.settings))]; } catch { return []; }
    });
  } catch { return []; }
}
export function savePreset(name, settings) {
  const cleanName = String(name || '').trim().slice(0, 80);
  if (!cleanName) throw new Error('Give these settings a name first.');
  const list = savedPresets().filter(item => item.name !== cleanName);
  list.unshift(presetDocument(cleanName, settings));
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(list.slice(0, 40))); }
  catch { throw new Error('Browser storage is unavailable. Download the JSON preset instead.'); }
  return list;
}

export function renamePreset(name, replacement) {
  const cleanName = String(replacement || '').trim().slice(0, 80);
  if (!cleanName) throw new Error('Enter the new preset name first.');
  const list = savedPresets();
  const selected = list.find(item => item.name === name);
  if (!selected) throw new Error('Select a saved preset to rename.');
  if (name !== cleanName && list.some(item => item.name === cleanName)) throw new Error('Another preset already uses that name. Choose a different name.');
  selected.name = cleanName;
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(list)); }
  catch { throw new Error('Browser storage is unavailable. Download a JSON preset instead.'); }
  return cleanName;
}

export function deletePreset(name) {
  const list = savedPresets();
  if (!list.some(item => item.name === name)) throw new Error('Select a saved preset to delete.');
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(list.filter(item => item.name !== name))); }
  catch { throw new Error('Browser storage is unavailable; the preset could not be deleted.'); }
}

export const SCENES = [
  {id:'natural', name:'Natural / uncolored', tag:'A clean starting point', description:'Full-band capture with a sample-peak limiter. Add only the processing you need.', patch:{}},
  {id:'street-voice', name:'Street interview', tag:'Speech over road noise', description:'RNNoise focuses on speech; other people speaking may remain. Keep original audio for a fresh render.', patch:{speech:true,highpassHz:90,lowpassHz:18000,compressorEnabled:true,compressorThresholdDb:-24,compressorRatio:2.5}},
  {id:'voice-wind', name:'Voice in wind', tag:'Speech with gusts', description:'Speech enhancement and a higher low cut reduce buffeting. A windscreen still protects the original capture.', patch:{speech:true,highpassHz:130,compressorEnabled:true,compressorRatio:2}},
  {id:'voice-room', name:'Voice / fan & room', tag:'Calls, narration, podcasts', description:'Speech enhancement for fan and room noise with a gentle low cut. Hum filtering is optional.', patch:{speech:true,highpassHz:70,compressorEnabled:true,compressorRatio:2.5}},
  {id:'birds-wind', name:'Birdcalls in wind', tag:'Keep calls and detail', description:'Conservative low cut. Learn a noise-only moment before adding reduction; lower the cut for deep coos. Speech enhancement stays off.', patch:{highpassHz:160,denoise:0.25}},
  {id:'birds-road', name:'Birdcalls near traffic', tag:'Reduce distant rumble', description:'Low-frequency attenuation and a light learned-noise treatment. Passing cars can overlap the calls.', patch:{highpassHz:240,denoise:0.3}},
  {id:'hail', name:'Hail / impact detail', tag:'Preserve the attacks', description:'A mild low cut reduces rumble while retaining strikes. Rain impacts can remain; this preset does not isolate hail semantically.', patch:{highpassHz:130,denoise:0.15,eqGains:{6:2,7:2}}},
  {id:'thunder', name:'Thunder / low ambience', tag:'Keep the body and decay', description:'Preserves low-frequency energy. No speech denoiser or gate. Change the low cut cautiously.', patch:{highpassHz:20,lowpassHz:18000}},
  {id:'rain', name:'Rain / environmental texture', tag:'Keep continuous ambience', description:'Light rumble control; no gate or speech suppression to erase the texture.', patch:{highpassHz:35}},
  {id:'dawn', name:'Dawn chorus / insects', tag:'Preserve quiet wildlife', description:'Wide bandwidth with very light optional noise-profile reduction. Continuous insects are wanted sound here.', patch:{highpassHz:40,denoise:0.12}},
  {id:'acoustic', name:'Acoustic music', tag:'Preserve tone and stereo', description:'Gentle rumble control with speech enhancement disabled. Keep reduction subtle around harmonics.', patch:{highpassHz:35}},
  {id:'hum', name:'Electrical hum', tag:'50 or 60 Hz interference', description:'Starts with 60 Hz mains filtering. Choose 50 Hz where appropriate; harmonics may also be musical content.', patch:{humHz:60}},
];

export const MICROPHONES = [
  {id:'neutral', name:'Unknown / flat starting point', channels:2, highpass:20, description:'No assumed frequency correction. Choose your real input device, then measure the level.'},
  {id:'laptop', name:'Built-in laptop microphone', channels:1, highpass:100, description:'Start with speech close to the laptop. Fan vibration and automatic hardware processing can affect the capture.'},
  {id:'phone', name:'Phone / tablet microphone', channels:1, highpass:70, description:'Avoid covering the microphone opening. Keep the page in the foreground while recording.'},
  {id:'usb-condenser', name:'USB / studio condenser', channels:1, highpass:60, description:'A pop filter and slightly off-axis placement help with plosives. Set hardware gain before adding software gain.'},
  {id:'dynamic', name:'Dynamic vocal microphone', channels:1, highpass:70, description:'Use the appropriate interface gain and work near the mic. Software gain also raises the captured noise.'},
  {id:'lavalier', name:'Lavalier / clip-on', channels:1, highpass:100, description:'Secure the cable and keep fabric away from the capsule. Rumble filtering cannot recover clipped clothing impacts.'},
  {id:'shotgun', name:'Shotgun / directional', channels:1, highpass:50, description:'Aim the microphone at the subject and use wind protection outdoors. Directionality comes from the hardware.'},
  {id:'stereo', name:'Stereo field recorder / pair', channels:2, highpass:20, description:'Keep both channels and inspect correlation. Nature presets preserve stereo ambience.'},
  {id:'headset', name:'Headset / close-talk', channels:1, highpass:90, description:'Place the capsule beside the mouth, away from direct breath. Headphones are useful for monitoring.'},
  {id:'contact', name:'Contact / piezo microphone', channels:1, highpass:30, description:'The preamp input impedance affects tone. Start flat and use EQ after checking the mounting noise.'},
  {id:'measurement', name:'Measurement microphone', channels:1, highpass:20, description:'A flat workflow, not a calibration. Levels remain dBFS; no absolute SPL is inferred.'},
];

export function applyScene(settings, id) {
  const scene = SCENES.find(item => item.id === id) || SCENES[0];
  const next = defaultSettings();
  next.microphoneProfile = settings.microphoneProfile;
  next.inputGainDb = settings.inputGainDb;
  next.noiseProfile = settings.noiseProfile;
  const {eqGains, ...patch} = scene.patch;
  Object.assign(next, patch, {scene:scene.id});
  for (const [index, gain] of Object.entries(eqGains || {})) next.eq[Number(index)].gain = gain;
  return validateSettings(next);
}
