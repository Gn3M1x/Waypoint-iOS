// SPDX-License-Identifier: GPL-3.0-or-later
// Screen-space motion for the demo map. The outer marker follows the reported
// position, while its child moves a few pixels in the direction of travel.
export class RunningMarker {
  constructor(element) {
    this.element = element;
  }

  stop() {
    this.animation?.cancel();
    this.animation = null;
    this.previous = this.position = this.view = null;
    this.element.hidden = true;
    this.element.style.transition = 'none';
    this.element.style.rotate = '0rad';
  }

  update(snapshot, enabled) {
    if (!enabled || !snapshot?.demo || !snapshot.position || !['moving','paused'].includes(snapshot.state)) {
      if (!this.element.hidden) this.stop();
      return;
    }
    const p = snapshot.position;
    if (!this.position || this.position[0] !== p[0] || this.position[1] !== p[1]) {
      this.previous = this.position;
      this.position = p;
    }
    this.moving = snapshot.state === 'moving';
    if (!this.animation) {
      const frames = [{transform:'translate(0, 0)'}];
      for (let i = 0; i < 12; i++) {
        const forward = 1 + Math.random() * 2;
        const side = (i % 2 ? -1 : 1) * (1.3 + Math.random() * 2);
        frames.push({transform:'translate(' + forward + 'px,' + side + 'px)', easing:'ease-in-out'});
        frames.push({transform:'translate(0, 0)', easing:'ease-in-out'});
      }
      this.animation = this.element.firstElementChild.animate(frames, {duration:4600, iterations:Infinity});
    }
    if (this.moving) {
      this.animation.updatePlaybackRate(Math.min(1.6, Math.max(0.65, snapshot.current_speed / 9)));
      if (this.animation.playState === 'paused') this.animation.play();
    } else {
      this.animation.pause();
    }
    this.element.hidden = false;
  }

  place(map) {
    if (this.element.hidden) return;
    const camera = map.world(map.center);
    const [x,y] = map.screen(this.position, camera);
    this.element.style.transition = this.moving && this.view === map.lastView ? 'translate 450ms linear' : 'none';
    this.element.style.translate = x + 'px ' + y + 'px';
    if (this.previous) {
      const [px,py] = map.screen(this.previous, camera);
      let dx = x - px;
      dx -= Math.round(dx / map.scale) * map.scale;
      this.element.style.rotate = Math.atan2(y - py, dx) + 'rad';
    }
    this.view = map.lastView;
  }
}

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
