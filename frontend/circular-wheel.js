/**
 * 环形转盘选择器 (Circular Donut Wheel Picker)
 * 严格按照手绘原型设计：半开环形转盘 + 9点钟(正左侧)目标选定框
 * 电脑端支持大尺寸高清展示与自适应屏幕，左半边高光凸显，右半边柔和渐变融入右侧操作区
 */
class CircularWheel {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.items = options.items || [];
    this.selectedIndex = options.selectedIndex || 0;
    this.onSelect = options.onSelect || (() => {});
    this.type = options.type || 'minister';
    
    // 动态尺寸计算：根据配置或屏幕宽度自适应 (电脑端460px，手机端350px)
    this.size = options.size || (window.innerWidth >= 1024 ? 460 : 350);
    this.calcDimensions();
    
    // 目标对准框位于正左侧 (9点钟方向，对应弧度 Math.PI)
    this.targetAngle = Math.PI; 
    
    // 当前转盘旋转角度 (弧度)
    this.rotation = 0;
    this.isDragging = false;
    this.hasMoved = false;
    this.startAngle = 0;
    this.startRotation = 0;
    this.lastAngle = 0;
    this.angularVelocity = 0;
    this.animId = null;

    // 高清屏 Retina 缩放适配
    this.dpr = window.devicePixelRatio || 1;
    this.initCanvasDPI();

    // 绑定鼠标与触控事件
    this.bindEvents();

    // 初始对齐
    this.snapToIndex(this.selectedIndex, false);
  }

  calcDimensions() {
    this.cx = this.size / 2;
    this.cy = this.size / 2;
    // 保持优雅的甜甜圈比例
    this.outerR = this.size * 0.415;
    this.innerR = this.size * 0.155;
  }

  resize(newSize) {
    if (newSize && newSize !== this.size) {
      this.size = newSize;
      this.calcDimensions();
      this.initCanvasDPI();
      this.draw();
    }
  }

  initCanvasDPI() {
    this.canvas.width = this.size * this.dpr;
    this.canvas.height = this.size * this.dpr;
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.size}px`;
    this.ctx.scale(this.dpr, this.dpr);
  }

  setItems(items, defaultIndex = 0) {
    this.items = items;
    if (this.selectedIndex >= items.length) {
      this.selectedIndex = 0;
    }
    this.snapToIndex(this.selectedIndex, false);
  }

  bindEvents() {
    const getPos = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return {
        x: clientX - rect.left,
        y: clientY - rect.top
      };
    };

    const getAngle = (x, y) => {
      return Math.atan2(y - this.cy, x - this.cx);
    };

    const onDown = (e) => {
      e.preventDefault();
      if (this.animId) cancelAnimationFrame(this.animId);
      
      const pos = getPos(e);
      const dist = Math.hypot(pos.x - this.cx, pos.y - this.cy);
      if (dist > this.outerR + 30 || dist < 12) return;

      this.isDragging = true;
      this.hasMoved = false;
      this.startAngle = getAngle(pos.x, pos.y);
      this.lastAngle = this.startAngle;
      this.startRotation = this.rotation;
      this.angularVelocity = 0;
      this.canvas.style.cursor = 'grabbing';

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onUp);
    };

    const onMove = (e) => {
      if (!this.isDragging) return;
      const pos = getPos(e);
      const curAngle = getAngle(pos.x, pos.y);
      let delta = curAngle - this.lastAngle;

      if (delta > Math.PI) delta -= 2 * Math.PI;
      else if (delta < -Math.PI) delta += 2 * Math.PI;

      if (Math.abs(curAngle - this.startAngle) > 0.025) {
        this.hasMoved = true;
      }

      this.rotation += delta;
      this.angularVelocity = delta;
      this.lastAngle = curAngle;

      this.draw();
      this.calcCurrentSelection();
    };

    const onUp = (e) => {
      if (!this.isDragging) return;
      this.isDragging = false;
      this.canvas.style.cursor = 'grab';

      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);

      // 单击扇区直接对齐
      if (!this.hasMoved && e.clientX !== undefined) {
        const rect = this.canvas.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;
        const dist = Math.hypot(clickX - this.cx, clickY - this.cy);
        if (dist >= this.innerR && dist <= this.outerR + 20) {
          const clickAngle = getAngle(clickX, clickY);
          this.rotateClickedAngleToTarget(clickAngle);
          return;
        }
      }

      this.snapToClosest();
    };

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const step = e.deltaY > 0 ? 1 : -1;
      this.step(step);
    }, { passive: false });

    this.canvas.addEventListener('mousedown', onDown);
    this.canvas.addEventListener('touchstart', onDown, { passive: false });
    this.canvas.style.cursor = 'grab';
  }

  calcCurrentSelection() {
    if (!this.items || this.items.length === 0) return 0;
    const n = this.items.length;
    const sliceAngle = (2 * Math.PI) / n;

    let diff = (this.targetAngle - this.rotation) % (2 * Math.PI);
    if (diff < 0) diff += 2 * Math.PI;

    let index = Math.floor(diff / sliceAngle) % n;
    if (index !== this.selectedIndex) {
      this.selectedIndex = index;
      this.onSelect(this.items[index], index);
    }
    return index;
  }

  rotateClickedAngleToTarget(angle) {
    if (!this.items || this.items.length === 0) return;
    const n = this.items.length;
    const sliceAngle = (2 * Math.PI) / n;

    let diff = (angle - this.rotation) % (2 * Math.PI);
    if (diff < 0) diff += 2 * Math.PI;
    const clickedIndex = Math.floor(diff / sliceAngle) % n;

    this.snapToIndex(clickedIndex, true);
  }

  step(delta) {
    if (!this.items || this.items.length === 0) return;
    const n = this.items.length;
    let target = (this.selectedIndex + delta + n) % n;
    this.snapToIndex(target, true);
  }

  spinRandom() {
    if (!this.items || this.items.length === 0) return;
    const n = this.items.length;
    const randomIdx = Math.floor(Math.random() * n);
    const extraRounds = (2 + Math.floor(Math.random() * 2)) * 2 * Math.PI;
    this.snapToIndex(randomIdx, true, extraRounds);
  }

  snapToIndex(index, animate = true, extraSpin = 0) {
    if (!this.items || this.items.length === 0) return;
    const n = this.items.length;
    const sliceAngle = (2 * Math.PI) / n;

    let idealRotation = this.targetAngle - (index * sliceAngle + sliceAngle / 2);
    if (extraSpin > 0) {
      idealRotation -= extraSpin;
    }

    if (!animate) {
      this.rotation = idealRotation;
      this.selectedIndex = index;
      this.draw();
      this.onSelect(this.items[index], index);
      return;
    }

    let current = this.rotation;
    if (extraSpin === 0) {
      let diff = (idealRotation - current) % (2 * Math.PI);
      if (diff > Math.PI) diff -= 2 * Math.PI;
      else if (diff < -Math.PI) diff += 2 * Math.PI;
      idealRotation = current + diff;
    }

    const startTime = performance.now();
    const duration = extraSpin > 0 ? 1100 : 320;
    const startRot = this.rotation;

    const animateStep = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const ease = 1 - Math.pow(1 - progress, 3);
      this.rotation = startRot + (idealRotation - startRot) * ease;
      this.draw();

      if (progress < 1) {
        this.animId = requestAnimationFrame(animateStep);
      } else {
        this.rotation = idealRotation;
        this.selectedIndex = index;
        this.draw();
        this.onSelect(this.items[index], index);
      }
    };

    if (this.animId) cancelAnimationFrame(this.animId);
    this.animId = requestAnimationFrame(animateStep);
  }

  snapToClosest() {
    const idx = this.calcCurrentSelection();
    this.snapToIndex(idx, true);
  }

  draw() {
    const { ctx, cx, cy, outerR, innerR, items, rotation, size } = this;
    ctx.clearRect(0, 0, size, size);

    const n = items.length;
    if (n === 0) return;
    const sliceAngle = (2 * Math.PI) / n;

    // 1. 底层光晕
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, outerR + 6, 0, 2 * Math.PI);
    ctx.fillStyle = '#E4D9C8';
    ctx.shadowColor = 'rgba(90, 70, 50, 0.15)';
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 4;
    ctx.fill();
    ctx.restore();

    // 字体尺寸比例
    const baseFontSize = Math.round(size * 0.034); // ~15.5px at 460
    const selectedFontSize = Math.round(size * 0.038); // ~17.5px at 460

    // 2. 扇区绘制
    for (let i = 0; i < n; i++) {
      const startAngle = rotation + i * sliceAngle;
      const endAngle = startAngle + sliceAngle;
      const item = items[i];
      const isDisabled = this.type === 'minister' ? item.is_full : item.is_matched;
      const isSelected = i === this.selectedIndex;

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, outerR, startAngle, endAngle);
      ctx.arc(cx, cy, innerR, endAngle, startAngle, true);
      ctx.closePath();

      if (isDisabled) {
        ctx.fillStyle = isSelected ? '#DFD6C8' : (i % 2 === 0 ? '#ECE4D7' : '#E6DDD0');
      } else if (isSelected) {
        ctx.fillStyle = '#FFF8EB';
      } else {
        ctx.fillStyle = i % 2 === 0 ? '#FCF9F2' : '#F6EFE3';
      }
      ctx.fill();

      // 分割线
      ctx.strokeStyle = '#D8CABE';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // 扇区文字
      const midAngle = startAngle + sliceAngle / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(midAngle);

      const textDist = (outerR + innerR) / 2;
      ctx.translate(textDist, 0);

      // 左半球自动反转文字保持正向
      let normAngle = (midAngle % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      let isLeftHemisphere = normAngle > Math.PI / 2 && normAngle < (3 * Math.PI) / 2;
      if (isLeftHemisphere) {
        ctx.rotate(Math.PI);
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      if (isDisabled) {
        ctx.fillStyle = '#9E9081';
        ctx.font = `${baseFontSize - 1}px "Times New Roman", "STZhongsong", "华文中宋", serif`;
        const label = item.name;
        ctx.fillText(label, 0, 0);
      } else {
        ctx.fillStyle = isSelected ? '#8A5220' : '#2B231D';
        ctx.font = isSelected 
          ? `bold ${selectedFontSize}px "Times New Roman", "STZhongsong", "华文中宋", serif`
          : `${baseFontSize}px "Times New Roman", "STZhongsong", "华文中宋", serif`;
        
        const genderTag = item.gender ? ` [${item.gender}]` : '';
        ctx.fillText(item.name + genderTag, 0, 0);
      }

      ctx.restore();
      ctx.restore();
    }

    // 3. 中心同心轴
    const centerHubR = innerR * 0.45;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, innerR, 0, 2 * Math.PI);
    ctx.fillStyle = '#ECE3D4';
    ctx.shadowColor = 'rgba(70, 50, 30, 0.12)';
    ctx.shadowBlur = 8;
    ctx.fill();

    ctx.strokeStyle = '#C9BAA3';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, centerHubR, 0, 2 * Math.PI);
    ctx.fillStyle = '#966B43';
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold ${Math.round(centerHubR * 0.46)}px "Times New Roman", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('SPIN', cx, cy);
    ctx.restore();

    // 4. 正左侧目标框
    this.drawTargetIndicator();
  }

  drawTargetIndicator() {
    const { ctx, cx, cy, outerR, innerR, size } = this;
    ctx.save();

    const xOuter = cx - outerR - (size * 0.024);
    const xInner = cx - innerR + (size * 0.016);
    const halfHOuter = size * 0.086;
    const halfHInner = size * 0.052;

    // 绘制梯形包围框
    ctx.beginPath();
    ctx.moveTo(xOuter, cy - halfHOuter);
    ctx.lineTo(xInner, cy - halfHInner);
    ctx.lineTo(xInner, cy + halfHInner);
    ctx.lineTo(xOuter, cy + halfHOuter);
    ctx.closePath();

    ctx.fillStyle = 'rgba(217, 167, 74, 0.18)';
    ctx.fill();

    ctx.strokeStyle = '#B45309';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(180, 83, 9, 0.35)';
    ctx.shadowBlur = 10;
    ctx.stroke();

    // 框顶部提示标
    ctx.beginPath();
    ctx.fillStyle = '#B45309';
    const tagW = Math.round(size * 0.16);
    const tagH = Math.round(size * 0.05);
    const tagX = xOuter + 6;
    const tagY = cy - halfHOuter - tagH + 4;
    
    ctx.roundRect 
      ? ctx.roundRect(tagX, tagY, tagW, tagH, 6)
      : ctx.rect(tagX, tagY, tagW, tagH);
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold ${Math.round(tagH * 0.58)}px "Times New Roman", "STZhongsong", "华文中宋", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🎯 当前选定', tagX + tagW / 2, tagY + tagH / 2);

    ctx.restore();
  }
}

window.CircularWheel = CircularWheel;
