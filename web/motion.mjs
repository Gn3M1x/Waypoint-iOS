// SPDX-License-Identifier: GPL-3.0-or-later
export function formatPace(seconds) {
  if(typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<=0)return '—';
  const rounded=Math.round(seconds);
  return `${Math.floor(rounded/60)}′${String(rounded%60).padStart(2,'0')}″/km`;
}

export function normaliseMotion(data) {
  if(!data||typeof data!=='object'||!['speed','pace'].includes(data.mode))throw Error('请选择速度或配速模式。');
  const finite=(value,min,max,label)=>{
    if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw Error(`${label}范围为 ${min}–${max}。`);
    return value;
  };
  const variation_percent=finite(data.variation_percent??12,0,30,'速度波动百分比');
  const randomize=data.randomize??(data.mode==='pace');
  if(typeof randomize!=='boolean')throw Error('随机变速选项无效。');
  if(data.mode==='pace'){
    const pace_seconds=finite(data.pace_seconds,60,3600,'配速秒数');
    return {mode:'pace',pace_seconds,speed:3600/pace_seconds,randomize,variation_percent};
  }
  const speed=finite(data.speed,0.5,30,'速度（km/h）');
  return {mode:'speed',speed,pace_seconds:3600/speed,randomize:false,variation_percent};
}
