/**
 * 双列 / 三列立式滚轮选择器 (Multi-Column Roller Picker)
 * 严格按照手绘原型设计：多立柱垂直滚动列表 + 横向贯通目标居中框
 * 特性：
 * 1. 鼠标拖拽平滑滚动、滚轮上下微调、点击条目直接吸附对齐
 * 2. 任何一列拖动到目标，无需点击任何添加按钮，实时自动联动
 * 3. 自动高亮居中选中项，支持满额/已配对条目置灰与防重复选择提示
 * 4. 支持单列模式 (1列)、双列模式 (2列) 与三列合体模式 (3列并排同屏浏览)
 */
class DualRollerPicker {
  constructor(containerEl, options = {}) {
    this.container = containerEl;
    this.singleColumn = !!options.singleColumn;
    this.columnCount = options.columns || options.columnCount || (options.col3Items ? 3 : (this.singleColumn ? 1 : 2));
    
    this.col1Items = options.col1Items || [];
    this.col2Items = options.col2Items || [];
    this.col3Items = options.col3Items || [];

    this.col1Title = options.col1Title || '第 1 意向';
    this.col2Title = options.col2Title || '第 2 意向';
    this.col3Title = options.col3Title || '第 3 意向';

    this.type = options.type || 'minister'; // 'minister' or 'mentee'
    this.disabled = !!options.disabled;
    this.lockText = options.lockText || '🔒 已锁定';
    this.onChange = options.onChange || (() => { });

    this.itemHeight = 54; // 每行固定高度 54px
    this.visibleCount = 5; // 可见行数 (中间第3行对齐选定框，上下各2行)

    this.col1Index = options.col1DefaultIndex !== undefined ? options.col1DefaultIndex : 0;
    this.col2Index = options.col2DefaultIndex !== undefined ? options.col2DefaultIndex : 0;
    this.col3Index = options.col3DefaultIndex !== undefined ? options.col3DefaultIndex : 0;

    // 事件清理函数队列
    this._cleanups = [];

    this.render();
    this.bindEvents();

    // 初始触发一次选中同步
    this.notifySelection();
  }

  setDisabled(disabled, lockText) {
    this.disabled = !!disabled;
    if (lockText) this.lockText = lockText;
    if (this.container) {
      const body = this.container.querySelector('.dual-roller-body');
      if (body) {
        if (this.disabled) {
          body.classList.add('pointer-events-none', 'opacity-65');
        } else {
          body.classList.remove('pointer-events-none', 'opacity-65');
        }
      }
      const cols = this.container.querySelectorAll('.roller-column');
      cols.forEach(c => {
        if (this.disabled) {
          c.classList.remove('cursor-grab', 'cursor-grabbing');
          c.classList.add('cursor-not-allowed');
        } else {
          c.classList.remove('cursor-not-allowed');
          c.classList.add('cursor-grab');
        }
      });
      const btns = this.container.querySelectorAll('.roller-step-btn');
      btns.forEach(b => {
        b.disabled = this.disabled;
        if (this.disabled) {
          b.classList.add('opacity-40', 'cursor-not-allowed', 'pointer-events-none');
        } else {
          b.classList.remove('opacity-40', 'cursor-not-allowed', 'pointer-events-none');
        }
      });
      const lockBadge = this.container.querySelector('.roller-lock-badge');
      if (lockBadge) {
        lockBadge.style.display = this.disabled ? 'flex' : 'none';
        const lockTextSpan = lockBadge.querySelector('.roller-lock-text');
        if (lockTextSpan && this.lockText) {
          lockTextSpan.textContent = this.lockText;
        }
      }
    }
  }

  setItems(...args) {
    let col1Items = [];
    let col2Items = [];
    let col3Items = [];
    let options = {};

    if (Array.isArray(args[2])) {
      col1Items = args[0] || [];
      col2Items = args[1] || [];
      col3Items = args[2] || [];
      options = args[3] || {};
      this.columnCount = 3;
    } else {
      col1Items = args[0] || [];
      col2Items = args[1] || [];
      options = args[2] || {};
      if (options.columns !== undefined) this.columnCount = options.columns;
      else if (options.columnCount !== undefined) this.columnCount = options.columnCount;
      else if (options.singleColumn) this.columnCount = 1;
      else this.columnCount = 2;
    }

    if (options.singleColumn !== undefined) this.singleColumn = !!options.singleColumn;
    if (options.col1Title) this.col1Title = options.col1Title;
    if (options.col2Title) this.col2Title = options.col2Title;
    if (options.col3Title) this.col3Title = options.col3Title;
    if (options.type) this.type = options.type;
    if (options.disabled !== undefined) this.disabled = !!options.disabled;

    this.col1Items = col1Items;
    this.col2Items = col2Items;
    this.col3Items = col3Items;

    if (options.col1DefaultIndex !== undefined) this.col1Index = options.col1DefaultIndex;
    if (options.col2DefaultIndex !== undefined) this.col2Index = options.col2DefaultIndex;
    if (options.col3DefaultIndex !== undefined) this.col3Index = options.col3DefaultIndex;

    if (this.col1Index >= this.col1Items.length) this.col1Index = 0;
    if (this.col2Index >= this.col2Items.length) this.col2Index = 0;
    if (this.col3Index >= this.col3Items.length) this.col3Index = 0;

    this.render();
    this.bindEvents();
    this.notifySelection();
  }

  resetToFirst(animate = false) {
    this.col1Index = 0;
    this.col2Index = 0;
    this.col3Index = 0;
    this.scrollToIndex(1, 0, animate);
    if (this.columnCount >= 2 && this.col2El) this.scrollToIndex(2, 0, animate);
    if (this.columnCount >= 3 && this.col3El) this.scrollToIndex(3, 0, animate);
    this.notifySelection();
  }

  destroy() {
    this.cleanupEvents();
    if (this.container) {
      this.container.innerHTML = '';
    }
  }

  cleanupEvents() {
    while (this._cleanups.length > 0) {
      const cleanup = this._cleanups.pop();
      try { cleanup(); } catch (e) { }
    }
  }

  render() {
    this.cleanupEvents();

    if (this.columnCount === 3) {
      this.renderTripleColumns();
    } else if (this.columnCount === 1 || this.singleColumn) {
      this.renderSingleColumn();
    } else {
      this.renderDualColumns();
    }

    this.col1El = this.container.querySelector('#roller-col-1');
    this.col2El = this.container.querySelector('#roller-col-2');
    this.col3El = this.container.querySelector('#roller-col-3');

    // 初始滚动定位 (无动画以防闪烁)
    setTimeout(() => {
      this.scrollToIndex(1, this.col1Index, false);
      if (this.columnCount >= 2 && this.col2El) {
        this.scrollToIndex(2, this.col2Index, false);
      }
      if (this.columnCount >= 3 && this.col3El) {
        this.scrollToIndex(3, this.col3Index, false);
      }
    }, 20);
  }

  renderDualColumns() {
    this.container.innerHTML = `
      <div class="dual-roller-wrapper relative select-none">
        <!-- 顶部列标签 -->
        <div class="grid grid-cols-2 gap-4 text-center mb-2.5">
          <div class="text-xs font-bold text-[#8A5220] tracking-wide flex items-center justify-center space-x-1">
            <span>${this.col1Title}</span>
          </div>
          <div class="text-xs font-bold text-[#2E5A88] tracking-wide flex items-center justify-center space-x-1">
            <span>${this.col2Title}</span>
          </div>
        </div>

        <!-- 滚轮双列主体容器 -->
        <div class="dual-roller-body relative bg-[#FAF7F0] border-2 border-[#D8CDBD] rounded-2xl overflow-hidden shadow-inner flex ${this.disabled ? 'pointer-events-none opacity-65' : ''}">
          
          <!-- 横向居中贯通选定框 -->
          <div class="roller-horizontal-frame pointer-events-none flex items-center justify-center">
            <span class="roller-frame-tag left-3"></span>
            <span class="roller-frame-tag right-3"></span>
            <div class="roller-lock-badge items-center justify-center" style="display: ${this.disabled ? 'flex' : 'none'};">
              <span class="roller-lock-text bg-[#2B231D]/85 text-white text-[11px] px-2.5 py-0.5 rounded-full font-bold shadow-md tracking-wider">${this.lockText || '🔒 已锁定'}</span>
            </div>
          </div>

          <!-- 顶部与底部柔和羽化渐变遮罩 -->
          <div class="roller-fade-top pointer-events-none"></div>
          <div class="roller-fade-bottom pointer-events-none"></div>

          <!-- 第一列滚轮 (Col 1) -->
          <div class="roller-column flex-1 relative border-r border-[#E2D8C7] overflow-y-auto ${this.disabled ? 'cursor-not-allowed' : 'cursor-grab'}" id="roller-col-1">
            <div class="roller-padding-top" style="height: ${this.itemHeight * 2}px;"></div>
            <div class="roller-list">
              ${this.col1Items.map((item, idx) => this.renderItem(item, idx, 1)).join('')}
            </div>
            <div class="roller-padding-bottom" style="height: ${this.itemHeight * 2}px;"></div>
          </div>

          <!-- 第二列滚轮 (Col 2) -->
          <div class="roller-column flex-1 relative overflow-y-auto ${this.disabled ? 'cursor-not-allowed' : 'cursor-grab'}" id="roller-col-2">
            <div class="roller-padding-top" style="height: ${this.itemHeight * 2}px;"></div>
            <div class="roller-list">
              ${this.col2Items.map((item, idx) => this.renderItem(item, idx, 2)).join('')}
            </div>
            <div class="roller-padding-bottom" style="height: ${this.itemHeight * 2}px;"></div>
          </div>

        </div>

        <!-- 底部轻量辅助微调按钮栏 -->
        <div class="grid grid-cols-2 gap-3 sm:gap-4 mt-3">
          <div class="flex items-center justify-center space-x-2">
            <button ${this.disabled ? 'disabled' : ''} data-col="1" data-step="-1" aria-label="上一个" title="上一个" class="roller-step-btn flex-1 max-w-[80px] py-1.5 sm:py-2 bg-[#EAE1D2] hover:bg-[#DDD1BE] active:scale-95 text-[#473B2F] rounded-xl text-sm font-bold transition shadow-sm touch-manipulation select-none flex items-center justify-center ${this.disabled ? 'opacity-40 cursor-not-allowed pointer-events-none' : ''}">▲</button>
            <button ${this.disabled ? 'disabled' : ''} data-col="1" data-step="1" aria-label="下一个" title="下一个" class="roller-step-btn flex-1 max-w-[80px] py-1.5 sm:py-2 bg-[#EAE1D2] hover:bg-[#DDD1BE] active:scale-95 text-[#473B2F] rounded-xl text-sm font-bold transition shadow-sm touch-manipulation select-none flex items-center justify-center ${this.disabled ? 'opacity-40 cursor-not-allowed pointer-events-none' : ''}">▼</button>
          </div>
          <div class="flex items-center justify-center space-x-2">
            <button ${this.disabled ? 'disabled' : ''} data-col="2" data-step="-1" aria-label="上一个" title="上一个" class="roller-step-btn flex-1 max-w-[80px] py-1.5 sm:py-2 bg-[#EAE1D2] hover:bg-[#DDD1BE] active:scale-95 text-[#473B2F] rounded-xl text-sm font-bold transition shadow-sm touch-manipulation select-none flex items-center justify-center ${this.disabled ? 'opacity-40 cursor-not-allowed pointer-events-none' : ''}">▲</button>
            <button ${this.disabled ? 'disabled' : ''} data-col="2" data-step="1" aria-label="下一个" title="下一个" class="roller-step-btn flex-1 max-w-[80px] py-1.5 sm:py-2 bg-[#EAE1D2] hover:bg-[#DDD1BE] active:scale-95 text-[#473B2F] rounded-xl text-sm font-bold transition shadow-sm touch-manipulation select-none flex items-center justify-center ${this.disabled ? 'opacity-40 cursor-not-allowed pointer-events-none' : ''}">▼</button>
          </div>
        </div>
      </div>
    `;
  }

  renderTripleColumns() {
    this.container.innerHTML = `
      <div class="dual-roller-wrapper relative select-none w-full">
        <!-- 顶部列标签 (3 列均分) -->
        <div class="grid grid-cols-3 gap-1 sm:gap-4 text-center mb-2.5">
          <div class="text-[11px] sm:text-xs font-bold text-[#8A5220] tracking-wide flex items-center justify-center space-x-1 truncate px-1">
            <span>${this.col1Title}</span>
          </div>
          <div class="text-[11px] sm:text-xs font-bold text-[#8A5220] tracking-wide flex items-center justify-center space-x-1 truncate px-1">
            <span>${this.col2Title}</span>
          </div>
          <div class="text-[11px] sm:text-xs font-bold text-[#2E5A88] tracking-wide flex items-center justify-center space-x-1 truncate px-1">
            <span>${this.col3Title}</span>
          </div>
        </div>

        <!-- 滚轮三列主体容器 (合为一体) -->
        <div class="dual-roller-body relative bg-[#FAF7F0] border-2 border-[#D8CDBD] rounded-2xl overflow-hidden shadow-inner flex ${this.disabled ? 'pointer-events-none opacity-65' : ''}">
          
          <!-- 横向居中贯通选定框 (跨越三列) -->
          <div class="roller-horizontal-frame pointer-events-none flex items-center justify-center">
            <span class="roller-frame-tag left-2 sm:left-3"></span>
            <span class="roller-frame-tag right-2 sm:right-3"></span>
            <div class="roller-lock-badge items-center justify-center" style="display: ${this.disabled ? 'flex' : 'none'};">
              <span class="roller-lock-text bg-[#2B231D]/85 text-white text-[11px] px-2.5 py-0.5 rounded-full font-bold shadow-md tracking-wider">${this.lockText || '🔒 已锁定'}</span>
            </div>
          </div>

          <!-- 顶部与底部柔和羽化渐变遮罩 -->
          <div class="roller-fade-top pointer-events-none"></div>
          <div class="roller-fade-bottom pointer-events-none"></div>

          <!-- 第一列滚轮 (Col 1) -->
          <div class="roller-column flex-1 relative border-r border-[#E2D8C7] overflow-y-auto ${this.disabled ? 'cursor-not-allowed' : 'cursor-grab'}" id="roller-col-1">
            <div class="roller-padding-top" style="height: ${this.itemHeight * 2}px;"></div>
            <div class="roller-list">
              ${this.col1Items.map((item, idx) => this.renderItem(item, idx, 1)).join('')}
            </div>
            <div class="roller-padding-bottom" style="height: ${this.itemHeight * 2}px;"></div>
          </div>

          <!-- 第二列滚轮 (Col 2) -->
          <div class="roller-column flex-1 relative border-r border-[#E2D8C7] overflow-y-auto ${this.disabled ? 'cursor-not-allowed' : 'cursor-grab'}" id="roller-col-2">
            <div class="roller-padding-top" style="height: ${this.itemHeight * 2}px;"></div>
            <div class="roller-list">
              ${this.col2Items.map((item, idx) => this.renderItem(item, idx, 2)).join('')}
            </div>
            <div class="roller-padding-bottom" style="height: ${this.itemHeight * 2}px;"></div>
          </div>

          <!-- 第三列滚轮 (Col 3) -->
          <div class="roller-column flex-1 relative overflow-y-auto ${this.disabled ? 'cursor-not-allowed' : 'cursor-grab'}" id="roller-col-3">
            <div class="roller-padding-top" style="height: ${this.itemHeight * 2}px;"></div>
            <div class="roller-list">
              ${this.col3Items.map((item, idx) => this.renderItem(item, idx, 3)).join('')}
            </div>
            <div class="roller-padding-bottom" style="height: ${this.itemHeight * 2}px;"></div>
          </div>

        </div>

        <!-- 底部轻量微调按钮栏 (3 列均分) -->
        <div class="grid grid-cols-3 gap-2 sm:gap-4 mt-3">
          <div class="flex items-center justify-center space-x-1.5 sm:space-x-2">
            <button ${this.disabled ? 'disabled' : ''} data-col="1" data-step="-1" aria-label="上一个" title="上一个" class="roller-step-btn flex-1 max-w-[65px] py-1.5 sm:py-2 bg-[#EAE1D2] hover:bg-[#DDD1BE] active:scale-95 text-[#473B2F] rounded-xl text-sm font-bold transition shadow-sm touch-manipulation select-none flex items-center justify-center ${this.disabled ? 'opacity-40 cursor-not-allowed pointer-events-none' : ''}">▲</button>
            <button ${this.disabled ? 'disabled' : ''} data-col="1" data-step="1" aria-label="下一个" title="下一个" class="roller-step-btn flex-1 max-w-[65px] py-1.5 sm:py-2 bg-[#EAE1D2] hover:bg-[#DDD1BE] active:scale-95 text-[#473B2F] rounded-xl text-sm font-bold transition shadow-sm touch-manipulation select-none flex items-center justify-center ${this.disabled ? 'opacity-40 cursor-not-allowed pointer-events-none' : ''}">▼</button>
          </div>
          <div class="flex items-center justify-center space-x-1.5 sm:space-x-2">
            <button ${this.disabled ? 'disabled' : ''} data-col="2" data-step="-1" aria-label="上一个" title="上一个" class="roller-step-btn flex-1 max-w-[65px] py-1.5 sm:py-2 bg-[#EAE1D2] hover:bg-[#DDD1BE] active:scale-95 text-[#473B2F] rounded-xl text-sm font-bold transition shadow-sm touch-manipulation select-none flex items-center justify-center ${this.disabled ? 'opacity-40 cursor-not-allowed pointer-events-none' : ''}">▲</button>
            <button ${this.disabled ? 'disabled' : ''} data-col="2" data-step="1" aria-label="下一个" title="下一个" class="roller-step-btn flex-1 max-w-[65px] py-1.5 sm:py-2 bg-[#EAE1D2] hover:bg-[#DDD1BE] active:scale-95 text-[#473B2F] rounded-xl text-sm font-bold transition shadow-sm touch-manipulation select-none flex items-center justify-center ${this.disabled ? 'opacity-40 cursor-not-allowed pointer-events-none' : ''}">▼</button>
          </div>
          <div class="flex items-center justify-center space-x-1.5 sm:space-x-2">
            <button ${this.disabled ? 'disabled' : ''} data-col="3" data-step="-1" aria-label="上一个" title="上一个" class="roller-step-btn flex-1 max-w-[65px] py-1.5 sm:py-2 bg-[#EAE1D2] hover:bg-[#DDD1BE] active:scale-95 text-[#473B2F] rounded-xl text-sm font-bold transition shadow-sm touch-manipulation select-none flex items-center justify-center ${this.disabled ? 'opacity-40 cursor-not-allowed pointer-events-none' : ''}">▲</button>
            <button ${this.disabled ? 'disabled' : ''} data-col="3" data-step="1" aria-label="下一个" title="下一个" class="roller-step-btn flex-1 max-w-[65px] py-1.5 sm:py-2 bg-[#EAE1D2] hover:bg-[#DDD1BE] active:scale-95 text-[#473B2F] rounded-xl text-sm font-bold transition shadow-sm touch-manipulation select-none flex items-center justify-center ${this.disabled ? 'opacity-40 cursor-not-allowed pointer-events-none' : ''}">▼</button>
          </div>
        </div>
      </div>
    `;
  }

  renderSingleColumn() {
    this.container.innerHTML = `
      <div class="dual-roller-wrapper relative select-none w-full max-w-sm mx-auto">
        <!-- 顶部列标签 -->
        <div class="text-center mb-2.5">
          <div class="text-xs font-bold text-[#8A5220] tracking-wide flex items-center justify-center space-x-1">
            <span>${this.col1Title}</span>
          </div>
        </div>

        <!-- 单列主体容器 -->
        <div class="dual-roller-body relative bg-[#FAF7F0] border-2 border-[#D8CDBD] rounded-2xl overflow-hidden shadow-inner flex ${this.disabled ? 'pointer-events-none opacity-65' : ''}">
          
          <!-- 横向居中贯通选定框 -->
          <div class="roller-horizontal-frame pointer-events-none flex items-center justify-center">
            <span class="roller-frame-tag left-3"></span>
            <span class="roller-frame-tag right-3"></span>
            <div class="roller-lock-badge items-center justify-center" style="display: ${this.disabled ? 'flex' : 'none'};">
              <span class="roller-lock-text bg-[#2B231D]/85 text-white text-[11px] px-2.5 py-0.5 rounded-full font-bold shadow-md tracking-wider">${this.lockText || '🔒 已锁定'}</span>
            </div>
          </div>

          <!-- 顶部与底部柔和羽化渐变遮罩 -->
          <div class="roller-fade-top pointer-events-none"></div>
          <div class="roller-fade-bottom pointer-events-none"></div>

          <!-- 第一列滚轮 (Col 1) -->
          <div class="roller-column flex-1 relative overflow-y-auto ${this.disabled ? 'cursor-not-allowed' : 'cursor-grab'}" id="roller-col-1">
            <div class="roller-padding-top" style="height: ${this.itemHeight * 2}px;"></div>
            <div class="roller-list">
              ${this.col1Items.map((item, idx) => this.renderItem(item, idx, 1)).join('')}
            </div>
            <div class="roller-padding-bottom" style="height: ${this.itemHeight * 2}px;"></div>
          </div>

        </div>

        <!-- 底部微调按钮 -->
        <div class="flex items-center justify-center space-x-3 mt-3">
          <button ${this.disabled ? 'disabled' : ''} data-col="1" data-step="-1" aria-label="上一个" title="上一个" class="roller-step-btn w-12 sm:w-16 py-1.5 sm:py-2 bg-[#EAE1D2] hover:bg-[#DDD1BE] active:scale-95 text-[#473B2F] rounded-xl text-sm font-bold transition shadow-sm touch-manipulation select-none flex items-center justify-center ${this.disabled ? 'opacity-40 cursor-not-allowed pointer-events-none' : ''}">▲</button>
          <button ${this.disabled ? 'disabled' : ''} data-col="1" data-step="1" aria-label="下一个" title="下一个" class="roller-step-btn w-12 sm:w-16 py-1.5 sm:py-2 bg-[#EAE1D2] hover:bg-[#DDD1BE] active:scale-95 text-[#473B2F] rounded-xl text-sm font-bold transition shadow-sm touch-manipulation select-none flex items-center justify-center ${this.disabled ? 'opacity-40 cursor-not-allowed pointer-events-none' : ''}">▼</button>
        </div>
      </div>
    `;
  }

  renderItem(item, idx, colNum) {
    if (!item) return '';
    const isDisabled = this.type === 'minister' ? item.is_full : item.is_matched;
    const genderTag = item.gender ? `<span class="ml-1 text-[10px] sm:text-[11px] px-1.5 py-0.2 rounded-full ${isDisabled ? 'bg-[#EAE1D2] text-[#8C7C6D]' : (item.gender === '女' ? 'bg-[#FCE7F3] text-[#BE185D]' : 'bg-[#E0F2FE] text-[#0369A1]')}">${item.gender}</span>` : '';

    return `
      <div class="roller-item ${isDisabled ? 'disabled text-[#A89E92]' : 'text-[#2B231D]'}" 
           data-col="${colNum}" 
           data-index="${idx}" 
           style="height: ${this.itemHeight}px; line-height: ${this.itemHeight}px;">
        <span class="font-bold text-xs sm:text-base truncate max-w-full ${isDisabled ? 'text-[#A89E92]' : ''}">${item.name}</span>
        ${genderTag}
      </div>
    `;
  }

  bindEvents() {
    if (this.col1El) this.setupColumnInteraction(this.col1El, 1);
    if (this.col2El && this.columnCount >= 2) this.setupColumnInteraction(this.col2El, 2);
    if (this.col3El && this.columnCount >= 3) this.setupColumnInteraction(this.col3El, 3);

    // 辅助微调按钮
    this.container.querySelectorAll('.roller-step-btn').forEach(btn => {
      const clickHandler = (e) => {
        if (this.disabled) return;
        const col = parseInt(btn.dataset.col);
        const step = parseInt(btn.dataset.step);
        this.step(col, step);
      };
      btn.addEventListener('click', clickHandler);
      this._cleanups.push(() => btn.removeEventListener('click', clickHandler));
    });

    // 点击条目直接对齐
    this.container.querySelectorAll('.roller-item').forEach(itemEl => {
      const clickHandler = (e) => {
        if (this.disabled) return;
        const col = parseInt(itemEl.dataset.col);
        const idx = parseInt(itemEl.dataset.index);
        this.scrollToIndex(col, idx, true);
      };
      itemEl.addEventListener('click', clickHandler);
      this._cleanups.push(() => itemEl.removeEventListener('click', clickHandler));
    });
  }

  setupColumnInteraction(el, colNum) {
    let isDown = false;
    let startPageY = 0;
    let startScrollTop = 0;
    let lastWheelTime = 0;
    let scrollDebounceTimer = null;

    // 鼠标拖拽开始
    const onMouseDown = (e) => {
      if (this.disabled) return;
      isDown = true;
      startPageY = e.pageY;
      startScrollTop = el.scrollTop;
      el.style.scrollBehavior = 'auto'; // 拖拽中禁用平滑滚动以保证即时跟手
      el.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
    };

    // 鼠标拖拽移动
    const onMouseMove = (e) => {
      if (this.disabled || !isDown) return;
      e.preventDefault();
      const deltaY = e.pageY - startPageY;
      el.scrollTop = startScrollTop - deltaY;
    };

    // 鼠标拖拽释放
    const onMouseUp = () => {
      if (!isDown) return;
      isDown = false;
      el.style.cursor = this.disabled ? 'cursor-not-allowed' : 'grab';
      document.body.style.userSelect = '';
      if (!this.disabled) {
        el.style.scrollBehavior = 'smooth';
        this.snapToNearest(colNum);
      }
    };

    el.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    this._cleanups.push(() => el.removeEventListener('mousedown', onMouseDown));
    this._cleanups.push(() => window.removeEventListener('mousemove', onMouseMove));
    this._cleanups.push(() => window.removeEventListener('mouseup', onMouseUp));

    // 鼠标滚轮微调
    const onWheel = (e) => {
      if (this.disabled) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      const now = Date.now();
      if (now - lastWheelTime < 70) return; // 防抖，防止滚轮过快跳跃
      lastWheelTime = now;
      const step = e.deltaY > 0 ? 1 : -1;
      this.step(colNum, step);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    this._cleanups.push(() => el.removeEventListener('wheel', onWheel));

    // 手机移动端触摸优化 (支持真机丝滑拨轮手感，杜绝跳动与页面连带滚动冲突)
    let isTouching = false;
    let touchStartY = 0;
    let touchStartX = 0;
    let touchStartScroll = 0;
    let isVerticalSwipe = false;

    const onTouchStart = (e) => {
      if (this.disabled) return;
      if (!e.touches || e.touches.length !== 1) return;
      clearTimeout(scrollDebounceTimer);
      isTouching = true;
      isDown = true;
      isVerticalSwipe = false;
      touchStartY = e.touches[0].clientY;
      touchStartX = e.touches[0].clientX;
      touchStartScroll = el.scrollTop;
      el.style.scrollBehavior = 'auto';
    };

    const onTouchMove = (e) => {
      if (!isTouching || this.disabled) return;
      if (!e.touches || e.touches.length !== 1) return;
      const currentY = e.touches[0].clientY;
      const currentX = e.touches[0].clientX;
      const diffY = currentY - touchStartY;
      const diffX = currentX - touchStartX;

      if (!isVerticalSwipe) {
        if (Math.abs(diffY) > 6 || Math.abs(diffX) > 6) {
          if (Math.abs(diffY) > Math.abs(diffX)) {
            isVerticalSwipe = true;
          } else {
            isTouching = false;
            isDown = false;
            return;
          }
        }
      }

      if (isVerticalSwipe) {
        if (e.cancelable) e.preventDefault();
        el.scrollTop = touchStartScroll - diffY;
      }
    };

    const onTouchEnd = () => {
      if (!isTouching) return;
      isTouching = false;
      isDown = false;
      if (!this.disabled) {
        el.style.scrollBehavior = 'smooth';
        this.snapToNearest(colNum);
      }
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });

    this._cleanups.push(() => el.removeEventListener('touchstart', onTouchStart));
    this._cleanups.push(() => el.removeEventListener('touchmove', onTouchMove));
    this._cleanups.push(() => el.removeEventListener('touchend', onTouchEnd));
    this._cleanups.push(() => el.removeEventListener('touchcancel', onTouchEnd));

    // 监听惯性滚动停止后的对齐吸附
    const onScroll = () => {
      if (this.disabled) return;
      clearTimeout(scrollDebounceTimer);
      scrollDebounceTimer = setTimeout(() => {
        if (!isDown && !isTouching && !this.disabled) {
          this.snapToNearest(colNum);
        }
      }, 100);
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    this._cleanups.push(() => el.removeEventListener('scroll', onScroll));
  }

  step(colNum, delta) {
    if (this.disabled) return;
    const items = colNum === 1 ? this.col1Items : (colNum === 2 ? this.col2Items : this.col3Items);
    let curIdx = colNum === 1 ? this.col1Index : (colNum === 2 ? this.col2Index : this.col3Index);
    let target = curIdx + delta;
    if (target < 0) target = 0;
    if (target >= items.length) target = items.length - 1;
    this.scrollToIndex(colNum, target, true);
  }

  snapToNearest(colNum) {
    if (this.disabled) return;
    const el = colNum === 1 ? this.col1El : (colNum === 2 ? this.col2El : this.col3El);
    if (!el) return;

    const items = colNum === 1 ? this.col1Items : (colNum === 2 ? this.col2Items : this.col3Items);
    if (!items || items.length === 0) return;

    let targetIdx = Math.round(el.scrollTop / this.itemHeight);
    if (targetIdx < 0) targetIdx = 0;
    if (targetIdx >= items.length) targetIdx = items.length - 1;

    this.scrollToIndex(colNum, targetIdx, true);
  }

  scrollToIndex(colNum, index, animate = true) {
    const el = colNum === 1 ? this.col1El : (colNum === 2 ? this.col2El : this.col3El);
    if (!el) return;

    const targetScroll = index * this.itemHeight;

    if (animate) {
      el.style.scrollBehavior = 'smooth';
      el.scrollTo({
        top: targetScroll,
        behavior: 'smooth'
      });
    } else {
      el.style.scrollBehavior = 'auto';
      el.scrollTop = targetScroll;
    }

    if (colNum === 1) {
      this.col1Index = index;
    } else if (colNum === 2) {
      this.col2Index = index;
    } else if (colNum === 3) {
      this.col3Index = index;
    }

    this.updateItemActiveStyles(colNum, index);
    this.notifySelection();
  }

  updateItemActiveStyles(colNum, activeIdx) {
    const el = colNum === 1 ? this.col1El : (colNum === 2 ? this.col2El : this.col3El);
    if (!el) return;

    el.querySelectorAll('.roller-item').forEach((item, idx) => {
      if (idx === activeIdx) {
        item.classList.add('roller-item-selected');
      } else {
        item.classList.remove('roller-item-selected');
      }
    });
  }

  notifySelection() {
    const item1 = this.col1Items[this.col1Index] || null;
    const item2 = this.columnCount >= 2 ? (this.col2Items[this.col2Index] || null) : null;
    const item3 = this.columnCount >= 3 ? (this.col3Items[this.col3Index] || null) : null;
    this.onChange({
      col1Item: item1,
      col1Index: this.col1Index,
      col2Item: item2,
      col2Index: this.col2Index,
      col3Item: item3,
      col3Index: this.col3Index,
      columnCount: this.columnCount,
      singleColumn: this.singleColumn
    });
  }
}

window.DualRollerPicker = DualRollerPicker;
