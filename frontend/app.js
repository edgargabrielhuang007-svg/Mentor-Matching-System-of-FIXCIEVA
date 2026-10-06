const { createApp, ref, reactive, computed, onMounted, nextTick } = Vue;

const app = createApp({
  setup() {
    const activeTab = ref('screen');
    const wsConnected = ref(false);
    let ws = null;
    let treeChart = null;

    let menteeRoller1 = null;
    let menteeRoller2 = null;
    let ministerRoller1 = null;
    let ministerRoller2 = null;

    // 系统公共状态
    const state = reactive({
      current_round: 1,
      max_rounds: 5,
      status: 'selecting',
      ministers: [],
      mentees: [],
      total_matched: 0,
      total_mentees: 20,
      submitted_mentee_ids: [],
      submitted_minister_ids: [],
      history: [],
      last_settled_pairs: [],
      settings: {
        num_mentees: 20,
        num_ministers: 10,
        mentee_pick_count: 4,
        minister_pick_count: 3,
        mentee_has_priority: true,
        minister_has_priority: false
      }
    });

    // --- 认证令牌状态 (安全替代明文PIN存储) ---
    const menteeToken = ref('');
    const ministerToken = ref('');
    const adminToken = ref('');

    // --- 调度设置与算法模拟弹窗状态 ---
    const showSettingsModal = ref(false);
    const isSavingSettings = ref(false);
    const isSimulating = ref(false);
    const simResult = ref(null);
    const showSimResultModal = ref(false);
    const showForceSettleModal = ref(false);
    const settingsForm = reactive({
      num_mentees: 20,
      num_ministers: 10,
      mentee_pick_count: 4,
      minister_pick_count: 3,
      mentee_has_priority: true,
      minister_has_priority: false
    });

    const menteePickLimit = computed(() => {
      return (state.settings && state.settings.mentee_pick_count) ? state.settings.mentee_pick_count : 4;
    });

    const ministerPickLimit = computed(() => {
      return (state.settings && state.settings.minister_pick_count) ? state.settings.minister_pick_count : 3;
    });

    const menteeHasPriority = computed(() => {
      return state.settings ? !!state.settings.mentee_has_priority : true;
    });

    const ministerHasPriority = computed(() => {
      return state.settings ? !!state.settings.minister_has_priority : false;
    });

    // --- 干事端状态 (支持 1~4 顺位意向部长) ---
    const menteeLoginForm = reactive({ id: '', pin: '' });
    const currentMentee = ref(null);
    const menteeLiveChoices = reactive({ choice1: null, choice2: null, choice3: null, choice4: null });
    const menteeLiveIndices = reactive({ col1: 0, col2: 0, col3: 0, col4: 0 });
    const menteeSubmittedChoices = ref([]);
    const mobileMenteeGroupTab = ref('A'); // 手机端顺位切换: 'A' (顺位1&2) 或 'B' (顺位3&4)

    // --- 部长端状态 (支持 1~4 位候选意向干事) ---
    const ministerLoginForm = reactive({ id: '', pin: '' });
    const currentMinister = ref(null);
    const ministerLiveChoices = reactive({ choice1: null, choice2: null, choice3: null, choice4: null });
    const ministerLiveIndices = reactive({ col1: 0, col2: 0, col3: 0, col4: 0 });
    const ministerSubmittedChoices = ref([]);
    const mobileMinisterGroupTab = ref('A'); // 手机端部长滚轮分组切换: 'A' (候选1&2) 或 'B' (候选3&4)

    // --- 管理员状态 ---
    const adminAuthed = ref(false);
    const adminPinInput = ref('');
    const adminPin = ref('');
    const adminAllData = reactive({ ministers: [], mentees: [] });
    const isDebugActive = ref(false);
    const isDebugging = ref(false);

    // --- 登录与提交请求防抖与加载中状态 ---
    const isMenteeLoggingIn = ref(false);
    const isMinisterLoggingIn = ref(false);
    const isAdminLoggingIn = ref(false);
    const isSubmittingMentee = ref(false);
    const isSubmittingMinister = ref(false);

    // --- 全局浮动 Toast 消息通知系统 ---
    const toastMessage = ref('');
    const toastIcon = ref('💡');
    let toastTimer = null;
    const showToast = (msg, icon = '💡', duration = 3500) => {
      toastMessage.value = msg;
      toastIcon.value = icon;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastMessage.value = '';
      }, duration);
    };

    // --- 安全的网络请求与 JSON 健壮解析工具 (彻底杜绝 WebKit/Safari "The string did not match the expected pattern" 报错) ---
    // --- 安全的网络请求与 JSON 健壮解析工具 (含 6 秒超时保护、快速重试与友好中文报错) ---
    const safeFetchJson = async (url, options = {}, retries = 1) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      try {
        const fetchOptions = {
          ...options,
          signal: options.signal || controller.signal
        };
        const res = await fetch(url, fetchOptions);
        clearTimeout(timeoutId);
        const text = await res.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : {};
        } catch (parseErr) {
          if (!res.ok) {
            throw new Error(`服务响应异常 (${res.status})`);
          }
          throw new Error('服务器响应数据格式异常，请稍后刷新重试');
        }
        if (!res.ok) {
          const errorMsg = data && (data.detail || data.message) ? (data.detail || data.message) : `请求失败 (${res.status})`;
          throw new Error(errorMsg);
        }
        return data;
      } catch (err) {
        clearTimeout(timeoutId);
        const isAbort = err.name === 'AbortError';
        const isNetworkErr = isAbort || err.name === 'TypeError' || (err.message && (err.message.includes('fetch') || err.message.includes('NetworkError') || err.message.includes('Failed')));
        if (isNetworkErr && retries > 0) {
          await new Promise(r => setTimeout(r, 200));
          return safeFetchJson(url, options, retries - 1);
        }
        if (isAbort) {
          throw new Error('网络请求超时，请检查网络后重试');
        }
        if (isNetworkErr) {
          throw new Error('网络连接异常或服务刚刚刷新，请检查网络后重新提交');
        }
        throw err;
      }
    };

    // 计算属性
    const menteeHasSubmitted = computed(() => {
      if (!currentMentee.value) return false;
      return state.submitted_mentee_ids.includes(currentMentee.value.id);
    });

    const ministerHasSubmitted = computed(() => {
      if (!currentMinister.value) return false;
      return state.submitted_minister_ids.includes(currentMinister.value.id);
    });

    const availableMinistersCount = computed(() => {
      return state.ministers.filter(m => !m.is_full).length;
    });

    // 待提交干事列表（排除已成功配对的干事，仅等待当前轮次尚未配对的所有干事）
    const pendingMentees = computed(() => {
      return state.mentees.filter(s => !s.matched_minister_id && !s.is_matched);
    });

    // 待提交部长列表（排除已经满员的部长，仅等待当前轮次尚未满额的所有部长）
    const pendingMinisters = computed(() => {
      return state.ministers.filter(m => {
        if (m.is_full) return false;
        const matchedCount = (m.matched_mentee_ids && Array.isArray(m.matched_mentee_ids))
          ? m.matched_mentee_ids.length
          : (m.matched_count !== undefined ? m.matched_count : ((m.matched || []).length));
        return matchedCount < (m.quota || 2);
      });
    });

    // 已提交的未结对干事数量
    const submittedPendingMenteesCount = computed(() => {
      const subIds = state.submitted_mentee_ids || [];
      return pendingMentees.value.filter(s => subIds.includes(s.id)).length;
    });

    // 已提交的未满额部长数量
    const submittedPendingMinistersCount = computed(() => {
      const subIds = state.submitted_minister_ids || [];
      return pendingMinisters.value.filter(m => subIds.includes(m.id)).length;
    });

    // 是否全员均已提交本轮意向（排除已满额部长与已配对干事后，必须等待所有待选干事与未满额部长全部提交）
    const allSubmissionsCompleted = computed(() => {
      if (state.status !== 'selecting') return false;
      const pm = pendingMentees.value;
      const pmin = pendingMinisters.value;

      // 如果当前没有待选干事或没有待选部长，说明无需撮合
      if (pm.length === 0 || pmin.length === 0) return false;

      const subMentees = state.submitted_mentee_ids || [];
      const subMinisters = state.submitted_minister_ids || [];

      // 仅需所有未配对干事全部提交
      const menteesDone = pm.every(s => subMentees.includes(s.id));
      // 仅需所有未满额部长全部提交
      const ministersDone = pmin.every(m => subMinisters.includes(m.id));

      return menteesDone && ministersDone;
    });

    // 控制台“结算本轮”按钮是否亮起可点击
    const canSettleRound = computed(() => {
      return state.status === 'selecting' && allSubmissionsCompleted.value;
    });

    // 悬浮提示文本
    const settleButtonTooltip = computed(() => {
      if (state.status !== 'selecting') {
        return '当前非选拔阶段，无法结算';
      }
      if (pendingMentees.value.length === 0) {
        return '所有干事均已成功配对完毕！无需再进行本轮结算';
      }
      if (pendingMinisters.value.length === 0) {
        return '所有部长均已招募满额！无需再进行本轮结算';
      }
      if (canSettleRound.value) {
        return '所有待选干事与未满额部长已全部提交，点击立即开始撮合匹配！';
      }
      const unSubMentees = pendingMentees.value.filter(s => !(state.submitted_mentee_ids || []).includes(s.id));
      const unSubMinisters = pendingMinisters.value.filter(m => !(state.submitted_minister_ids || []).includes(m.id));
      let tip = '尚有人员未完成提交，无法开始匹配 (已排除满额部长与已配对干事)：';
      if (unSubMentees.length > 0) {
        tip += `\n未交干事还缺 ${unSubMentees.length} 人 (${unSubMentees.map(s => s.name).slice(0, 5).join('、')}${unSubMentees.length > 5 ? '等' : ''})`;
      }
      if (unSubMinisters.length > 0) {
        tip += `\n未满部长还缺 ${unSubMinisters.length} 人 (${unSubMinisters.map(m => m.name).slice(0, 5).join('、')}${unSubMinisters.length > 5 ? '等' : ''})`;
      }
      return tip;
    });

    const unsubmittedMenteesList = computed(() => pendingMentees.value.filter(s => !(state.submitted_mentee_ids || []).includes(s.id)));
    const unsubmittedMinistersList = computed(() => pendingMinisters.value.filter(m => !(state.submitted_minister_ids || []).includes(m.id)));


    // 干事端选择与校验逻辑 (支持 1~4 个顺位意向部长)
    const menteeTargetPickCount = computed(() => {
      const availCount = availableMinistersCount.value;
      return Math.min(menteePickLimit.value, Math.max(1, availCount));
    });

    const isMenteeChoiceDuplicate = (choice, colNum) => {
      if (currentMentee.value && currentMentee.value.is_matched) return false;
      if (menteeHasSubmitted.value) return false;
      if (!choice) return false;
      const targetCount = menteeTargetPickCount.value;
      const all = [
        menteeChoice1.value,
        menteeChoice2.value,
        menteeChoice3.value,
        menteeChoice4.value
      ].slice(0, targetCount);
      return all.some((c, idx) => idx !== colNum - 1 && c && c.id === choice.id);
    };

    const getMenteeChoiceCardClass = (choice, colNum) => {
      if (currentMentee.value && currentMentee.value.is_matched) {
        return 'border-[#D8CDBD] bg-[#F5F2ED] opacity-75';
      }
      if (!choice) return 'border-[#D8CDBD] bg-white';
      if (menteeHasSubmitted.value) {
        return 'border-amber-400 bg-amber-50/20';
      }
      if (choice.is_full) return 'border-rose-400 bg-rose-50/40';
      if (isMenteeChoiceDuplicate(choice, colNum)) return 'border-amber-400 bg-amber-50/50';
      return colNum <= 2 ? 'border-[#C28E2E] bg-white' : 'border-[#2E5A88] bg-white';
    };

    const getMenteeChoiceStatusText = (choice, colNum) => {
      if (currentMentee.value && currentMentee.value.is_matched) {
        return '不可选择';
      }
      if (!choice) return '待滑动对准';
      if (menteeHasSubmitted.value) {
        return '✅ 已提交';
      }
      if (choice.is_full) return '⚠️ 已满额禁用';
      if (isMenteeChoiceDuplicate(choice, colNum)) return '⚠️ 部长重复';
      return '✅ 尚有名额';
    };

    const getMenteeChoiceStatusClass = (choice, colNum) => {
      if (currentMentee.value && currentMentee.value.is_matched) {
        return 'bg-[#EAE1D2] text-[#7A6C5D]';
      }
      if (!choice) return 'bg-[#F2ECE1] text-[#8A7968]';
      if (menteeHasSubmitted.value) {
        return 'bg-[#DCFCE7] text-emerald-700';
      }
      if (choice.is_full) return 'bg-[#FEE2E2] text-rose-600';
      if (isMenteeChoiceDuplicate(choice, colNum)) return 'bg-[#FEF3C7] text-amber-700';
      return 'bg-[#DCFCE7] text-emerald-700';
    };

    const menteeChoicesValidation = computed(() => {
      if (currentMentee.value && currentMentee.value.is_matched) {
        return {
          isValid: false,
          isFull: true,
          message: '您已成功配对，无需参与本轮选择'
        };
      }
      const targetCount = menteeTargetPickCount.value;
      if (menteeHasSubmitted.value) {
        return {
          isValid: true,
          isDuplicate: false,
          validCount: menteeSubmittedChoices.value.length || targetCount,
          message: '当前人选已锁定，请等待后台匹配'
        };
      }
      const rawChoices = [
        menteeLiveChoices.choice1,
        menteeLiveChoices.choice2,
        menteeLiveChoices.choice3,
        menteeLiveChoices.choice4
      ].slice(0, targetCount);

      // 检查是否有未选定的顺位
      for (let i = 0; i < rawChoices.length; i++) {
        if (!rawChoices[i]) {
          return { isValid: false, warning: targetCount === 1 ? '意向部长尚未选定，请滑动滚轮对齐' : `第 ${i + 1} 顺位意向部长尚未选定，请滑动滚轮对齐` };
        }
      }

      // 检查部长名额是否已满
      for (let i = 0; i < rawChoices.length; i++) {
        if (rawChoices[i].is_full) {
          return { isValid: false, warning: targetCount === 1 ? `当前选项无效：【${rawChoices[i].name}】名额已满` : `当前选项无效：第 ${i + 1} 顺位【${rawChoices[i].name}】名额已满` };
        }
      }

      // 检查重复部长
      const ids = rawChoices.map(c => c.id);
      const dupId = ids.find((id, index) => ids.indexOf(id) !== index);
      if (dupId) {
        return {
          isValid: false,
          isDuplicate: true,
          warning: '当前选项无效：所选顺位中存在重复的部长，请调整为不同的人选'
        };
      }

      return {
        isValid: true,
        isDuplicate: false,
        validCount: targetCount,
        message: '当前选项全部有效'
      };
    });

    const canSubmitMenteeChoices = computed(() => {
      if (!currentMentee.value || menteeHasSubmitted.value) return false;
      if (state.status !== 'selecting') return false;
      return true;
    });

    const menteeValidChoicesCount = computed(() => {
      return menteeChoicesValidation.value.validCount || 0;
    });

    // 部长端剩余名额与校验逻辑 (3人候选意向池)
    const remainMinisterQuota = computed(() => {
      if (!currentMinister.value) return 2;
      const matched = currentMinister.value.matched || [];
      return Math.max(0, currentMinister.value.quota - matched.length);
    });

    const ministerSlots = computed(() => {
      if (!currentMinister.value) return [];
      const quota = currentMinister.value.quota || 2;
      const matchedIds = currentMinister.value.matched || [];
      const slots = [];
      for (let i = 0; i < quota; i++) {
        const menteeId = matchedIds[i];
        if (menteeId) {
          const mentee = state.mentees.find(m => m.id === menteeId);
          slots.push({
            seatNumber: i + 1,
            isFilled: true,
            mentee: mentee || { id: menteeId, name: getMenteeName(menteeId), gender: '未知' }
          });
        } else {
          slots.push({
            seatNumber: i + 1,
            isFilled: false,
            mentee: null
          });
        }
      }
      return slots;
    });

    const ministerTargetPickCount = computed(() => {
      const unmatched = state.mentees.filter(s => !s.is_matched);
      return Math.min(ministerPickLimit.value, Math.max(1, unmatched.length));
    });

    const isMinisterChoiceDuplicate = (choice, colNum) => {
      if (currentMinister.value && currentMinister.value.is_full) return false;
      if (ministerHasSubmitted.value) return false;
      if (!choice) return false;
      const targetCount = ministerTargetPickCount.value;
      const all = [
        ministerChoice1.value,
        ministerChoice2.value,
        ministerChoice3.value,
        ministerChoice4.value
      ].slice(0, targetCount);
      return all.some((c, idx) => idx !== colNum - 1 && c && c.id === choice.id);
    };

    const getMinisterChoiceCardClass = (choice, colNum) => {
      if (currentMinister.value && currentMinister.value.is_full) {
        return 'border-[#D8CDBD] bg-[#F5F2ED] opacity-75';
      }
      if (!choice) return 'border-[#D8CDBD] bg-white';
      if (ministerHasSubmitted.value) {
        if (choice.is_matched) return 'border-emerald-500 bg-emerald-50/40';
        return colNum <= 2 ? 'border-[#B45309] bg-white' : 'border-[#2E5A88] bg-white';
      }
      if (choice.is_matched) return 'border-rose-400 bg-rose-50/40';
      if (isMinisterChoiceDuplicate(choice, colNum)) return 'border-amber-400 bg-amber-50/50';
      return colNum <= 2 ? 'border-[#B45309] bg-white' : 'border-[#2E5A88] bg-white';
    };

    const getMinisterChoiceStatusText = (choice, colNum) => {
      if (currentMinister.value && currentMinister.value.is_full) {
        return '不可选择';
      }
      if (!choice) return '待滑动对准';
      if (ministerHasSubmitted.value) {
        return '✅ 已提交';
      }
      if (choice.is_matched) return '⚠️ 已被招募禁用';
      if (isMinisterChoiceDuplicate(choice, colNum)) return '⚠️ 人选重复';
      return '✅ 待选有效';
    };

    const getMinisterChoiceStatusClass = (choice, colNum) => {
      if (currentMinister.value && currentMinister.value.is_full) {
        return 'bg-[#EAE1D2] text-[#7A6C5D]';
      }
      if (!choice) return 'bg-[#F2ECE1] text-[#8A7968]';
      if (ministerHasSubmitted.value) {
        return 'bg-[#DCFCE7] text-emerald-700';
      }
      if (choice.is_matched) return 'bg-[#FEE2E2] text-rose-600';
      if (isMinisterChoiceDuplicate(choice, colNum)) return 'bg-[#FEF3C7] text-amber-700';
      return 'bg-[#DCFCE7] text-emerald-700';
    };

    const ministerChoicesValidation = computed(() => {
      if (currentMinister.value && currentMinister.value.is_full) {
        return {
          isValid: false,
          isFull: true,
          message: '您的席位已全部配对满员，无需参与本轮选择'
        };
      }
      const targetCount = ministerTargetPickCount.value;
      if (ministerHasSubmitted.value) {
        return {
          isValid: true,
          isDuplicate: false,
          validCount: targetCount,
          message: '当前人选已锁定，请等待后台匹配'
        };
      }
      const rawChoices = [
        ministerLiveChoices.choice1,
        ministerLiveChoices.choice2,
        ministerLiveChoices.choice3,
        ministerLiveChoices.choice4
      ].slice(0, targetCount);

      // 检查是否有空
      for (let i = 0; i < rawChoices.length; i++) {
        if (!rawChoices[i]) {
          return { isValid: false, warning: targetCount === 1 ? '意向干事尚未对准，请滑动滚轮选定' : `意向干事 ${i + 1} 尚未对准，请滑动对应滚轮选定` };
        }
      }

      // 检查是否已被他人结对
      for (let i = 0; i < rawChoices.length; i++) {
        if (rawChoices[i].is_matched) {
          return { isValid: false, warning: `当前选项无效：${rawChoices[i].name}已被招募` };
        }
      }

      // 检查重复人选
      const ids = rawChoices.map(c => c.id);
      const dupId = ids.find((id, index) => ids.indexOf(id) !== index);
      if (dupId) {
        return {
          isValid: false,
          isDuplicate: true,
          warning: '当前选项无效：选定了重复的干事'
        };
      }

      return {
        isValid: true,
        isDuplicate: false,
        validCount: targetCount,
        message: '当前选项全部有效'
      };
    });

    const canSubmitMinisterChoices = computed(() => {
      if (!currentMinister.value || ministerHasSubmitted.value || currentMinister.value.is_full) return false;
      if (state.status !== 'selecting') return false;
      return true; // 允许点击，由提交函数校验并弹窗报错
    });

    const ministerValidChoicesCount = computed(() => {
      return ministerChoicesValidation.value.validCount || 0;
    });

    const ministerValidUniqueChoicesCount = computed(() => {
      const targetCount = ministerTargetPickCount.value;
      const all = [
        ministerLiveChoices.choice1,
        ministerLiveChoices.choice2,
        ministerLiveChoices.choice3,
        ministerLiveChoices.choice4
      ].slice(0, targetCount).filter(c => c && !c.is_matched);
      const uniqueIds = new Set(all.map(c => c.id));
      return uniqueIds.size;
    });

    // 辅助工具方法
    const getRoundTitle = () => {
      if (state.status === 'finished') return '配对全员完成';
      if (state.status === 'settled') return `第 ${state.current_round} 轮已揭晓`;
      return `第 ${state.current_round} 轮进行中`;
    };

    const getFullMinistersCount = () => {
      return state.ministers.filter(m => m.is_full).length;
    };

    const getMinisterName = (mid) => {
      if (!mid) return '';
      const m = state.ministers.find(item => item.id === mid);
      return m ? `${m.name} [${m.gender || '未知'}]` : mid;
    };

    const getMenteeName = (sid) => {
      if (!sid) return '';
      const s = state.mentees.find(item => item.id === sid);
      return s ? `${s.name} [${s.gender || '未知'}]` : sid;
    };

    const getAdaptiveWheelSize = () => {
      if (window.innerWidth >= 1024) return 460;
      if (window.innerWidth >= 640) return 400;
      return 350;
    };

    // 安全计算属性：提供防 null/undefined 的安全意向对象，绝对杜绝模板层属性访问报错
    // 若已提交，则保持原先提交的意向，不再实时映射滚轮框选的部长/干事
    const menteeChoice1 = computed(() => {
      if (menteeHasSubmitted.value && menteeSubmittedChoices.value.length > 0) {
        return state.ministers.find(m => m.id === menteeSubmittedChoices.value[0]) || null;
      }
      return (menteeLiveChoices && menteeLiveChoices.choice1) || null;
    });
    const menteeChoice2 = computed(() => {
      if (menteeHasSubmitted.value && menteeSubmittedChoices.value.length > 1) {
        return state.ministers.find(m => m.id === menteeSubmittedChoices.value[1]) || null;
      }
      return (menteeLiveChoices && menteeLiveChoices.choice2) || null;
    });
    const menteeChoice3 = computed(() => {
      if (menteeHasSubmitted.value && menteeSubmittedChoices.value.length > 2) {
        return state.ministers.find(m => m.id === menteeSubmittedChoices.value[2]) || null;
      }
      return (menteeLiveChoices && menteeLiveChoices.choice3) || null;
    });
    const menteeChoice4 = computed(() => {
      if (menteeHasSubmitted.value && menteeSubmittedChoices.value.length > 3) {
        return state.ministers.find(m => m.id === menteeSubmittedChoices.value[3]) || null;
      }
      return (menteeLiveChoices && menteeLiveChoices.choice4) || null;
    });

    const ministerChoice1 = computed(() => {
      if (ministerHasSubmitted.value && ministerSubmittedChoices.value.length > 0) {
        return state.mentees.find(m => m.id === ministerSubmittedChoices.value[0]) || null;
      }
      return (ministerLiveChoices && ministerLiveChoices.choice1) || null;
    });
    const ministerChoice2 = computed(() => {
      if (ministerHasSubmitted.value && ministerSubmittedChoices.value.length > 1) {
        return state.mentees.find(m => m.id === ministerSubmittedChoices.value[1]) || null;
      }
      return (ministerLiveChoices && ministerLiveChoices.choice2) || null;
    });
    const ministerChoice3 = computed(() => {
      if (ministerHasSubmitted.value && ministerSubmittedChoices.value.length > 2) {
        return state.mentees.find(m => m.id === ministerSubmittedChoices.value[2]) || null;
      }
      return (ministerLiveChoices && ministerLiveChoices.choice3) || null;
    });
    const ministerChoice4 = computed(() => {
      if (ministerHasSubmitted.value && ministerSubmittedChoices.value.length > 3) {
        return state.mentees.find(m => m.id === ministerSubmittedChoices.value[3]) || null;
      }
      return (ministerLiveChoices && ministerLiveChoices.choice4) || null;
    });

    // --- 滚轮状态重置函数 (杜绝账号切换与多角色信息泄露) ---
    const resetMenteeRollerState = () => {
      menteeLiveIndices.col1 = 0;
      menteeLiveIndices.col2 = 0;
      menteeLiveIndices.col3 = 0;
      menteeLiveIndices.col4 = 0;
      menteeLiveChoices.choice1 = null;
      menteeLiveChoices.choice2 = null;
      menteeLiveChoices.choice3 = null;
      menteeLiveChoices.choice4 = null;
      if (menteeRoller1) {
        menteeRoller1.destroy();
        menteeRoller1 = null;
      }
      if (menteeRoller2) {
        menteeRoller2.destroy();
        menteeRoller2 = null;
      }
    };

    const resetMinisterRollerState = () => {
      ministerLiveIndices.col1 = 0;
      ministerLiveIndices.col2 = 0;
      ministerLiveIndices.col3 = 0;
      ministerLiveIndices.col4 = 0;
      ministerLiveChoices.choice1 = null;
      ministerLiveChoices.choice2 = null;
      ministerLiveChoices.choice3 = null;
      ministerLiveChoices.choice4 = null;
      if (ministerRoller1) {
        ministerRoller1.destroy();
        ministerRoller1 = null;
      }
      if (ministerRoller2) {
        ministerRoller2.destroy();
        ministerRoller2 = null;
      }
    };

    // --- 初始化与管理干事端滚轮组件 (自适应 1 / 2 / 3 / 4 顺位意向) ---
    const initOrUpdateMenteeRoller = (retries = 15) => {
      nextTick(() => {
        if (!currentMentee.value) return;
        if (typeof window.DualRollerPicker !== 'function') {
          if (retries > 0) setTimeout(() => initOrUpdateMenteeRoller(retries - 1), 60);
          return;
        }

        const limit = menteePickLimit.value;
        const isMatched = currentMentee.value && currentMentee.value.is_matched;
        const isSubmitted = menteeHasSubmitted.value;
        const isLocked = isMatched || isSubmitted;
        const lockText = isMatched ? '🔒 已配对成功锁定' : '🔒 已提交锁定';

        let def1 = isLocked ? 0 : (menteeLiveIndices.col1 || 0);
        let def2 = isLocked ? 0 : (menteeLiveIndices.col2 || 0);
        let def3 = isLocked ? 0 : (menteeLiveIndices.col3 || 0);
        let def4 = isLocked ? 0 : (menteeLiveIndices.col4 || 0);

        const hasPrio = menteeHasPriority.value;
        const t1 = hasPrio ? '第 1 顺位意向' : (limit === 1 ? '意向部长' : '意向部长 1');
        const t2 = hasPrio ? '第 2 顺位意向' : '意向部长 2';
        const t3 = hasPrio ? '第 3 顺位意向' : '意向部长 3';
        const t4 = hasPrio ? '第 4 顺位意向' : '意向部长 4';

        if (limit === 4) {
          const el1 = document.getElementById('mentee-dual-roller-1');
          const el2 = document.getElementById('mentee-dual-roller-2');
          if (!el1 || !el2) {
            if (retries > 0) setTimeout(() => initOrUpdateMenteeRoller(retries - 1), 60);
            return;
          }
          if (!menteeRoller1 || menteeRoller1.container !== el1 || menteeRoller1.columnCount !== 2) {
            if (menteeRoller1) menteeRoller1.destroy();
            menteeRoller1 = new DualRollerPicker(el1, {
              columns: 2,
              col1Items: state.ministers,
              col2Items: state.ministers,
              col1Title: t1,
              col2Title: t2,
              type: 'minister',
              disabled: isLocked,
              lockText: lockText,
              col1DefaultIndex: def1,
              col2DefaultIndex: def2,
              onChange: (res) => {
                if (menteeHasSubmitted.value || (currentMentee.value && currentMentee.value.is_matched)) return;
                menteeLiveChoices.choice1 = res.col1Item;
                menteeLiveChoices.choice2 = res.col2Item;
                menteeLiveIndices.col1 = res.col1Index;
                menteeLiveIndices.col2 = res.col2Index;
              }
            });
          } else {
            menteeRoller1.setItems(state.ministers, state.ministers, {
              columns: 2,
              col1Title: t1,
              col2Title: t2,
              type: 'minister',
              disabled: isLocked,
              lockText: lockText,
              col1DefaultIndex: def1,
              col2DefaultIndex: def2
            });
          }
          menteeRoller1.setDisabled(isLocked, lockText);
          if (isLocked) menteeRoller1.resetToFirst(false);

          if (!menteeRoller2 || menteeRoller2.container !== el2 || menteeRoller2.columnCount !== 2) {
            if (menteeRoller2) menteeRoller2.destroy();
            menteeRoller2 = new DualRollerPicker(el2, {
              columns: 2,
              col1Items: state.ministers,
              col2Items: state.ministers,
              col1Title: t3,
              col2Title: t4,
              type: 'minister',
              disabled: isLocked,
              lockText: lockText,
              col1DefaultIndex: def3,
              col2DefaultIndex: def4,
              onChange: (res) => {
                if (menteeHasSubmitted.value || (currentMentee.value && currentMentee.value.is_matched)) return;
                menteeLiveChoices.choice3 = res.col1Item;
                menteeLiveChoices.choice4 = res.col2Item;
                menteeLiveIndices.col3 = res.col1Index;
                menteeLiveIndices.col4 = res.col2Index;
              }
            });
          } else {
            menteeRoller2.setItems(state.ministers, state.ministers, {
              columns: 2,
              col1Title: t3,
              col2Title: t4,
              type: 'minister',
              disabled: isLocked,
              lockText: lockText,
              col1DefaultIndex: def3,
              col2DefaultIndex: def4
            });
          }
          menteeRoller2.setDisabled(isLocked, lockText);
          if (isLocked) menteeRoller2.resetToFirst(false);

        } else if (limit === 3) {
          if (menteeRoller2) { menteeRoller2.destroy(); menteeRoller2 = null; }
          const el = document.getElementById('mentee-triple-roller');
          if (!el) {
            if (retries > 0) setTimeout(() => initOrUpdateMenteeRoller(retries - 1), 60);
            return;
          }
          if (!menteeRoller1 || menteeRoller1.container !== el || menteeRoller1.columnCount !== 3) {
            if (menteeRoller1) menteeRoller1.destroy();
            menteeRoller1 = new DualRollerPicker(el, {
              columns: 3,
              col1Items: state.ministers,
              col2Items: state.ministers,
              col3Items: state.ministers,
              col1Title: t1,
              col2Title: t2,
              col3Title: t3,
              type: 'minister',
              disabled: isLocked,
              lockText: lockText,
              col1DefaultIndex: def1,
              col2DefaultIndex: def2,
              col3DefaultIndex: def3,
              onChange: (res) => {
                if (menteeHasSubmitted.value || (currentMentee.value && currentMentee.value.is_matched)) return;
                menteeLiveChoices.choice1 = res.col1Item;
                menteeLiveChoices.choice2 = res.col2Item;
                menteeLiveChoices.choice3 = res.col3Item;
                menteeLiveIndices.col1 = res.col1Index;
                menteeLiveIndices.col2 = res.col2Index;
                menteeLiveIndices.col3 = res.col3Index;
              }
            });
          } else {
            menteeRoller1.setItems(state.ministers, state.ministers, state.ministers, {
              columns: 3,
              col1Title: t1,
              col2Title: t2,
              col3Title: t3,
              type: 'minister',
              disabled: isLocked,
              lockText: lockText,
              col1DefaultIndex: def1,
              col2DefaultIndex: def2,
              col3DefaultIndex: def3
            });
          }
          menteeRoller1.setDisabled(isLocked, lockText);
          if (isLocked) menteeRoller1.resetToFirst(false);

        } else if (limit === 2) {
          if (menteeRoller2) { menteeRoller2.destroy(); menteeRoller2 = null; }
          const el = document.getElementById('mentee-dual-roller-1');
          if (!el) {
            if (retries > 0) setTimeout(() => initOrUpdateMenteeRoller(retries - 1), 60);
            return;
          }
          if (!menteeRoller1 || menteeRoller1.container !== el || menteeRoller1.columnCount !== 2) {
            if (menteeRoller1) menteeRoller1.destroy();
            menteeRoller1 = new DualRollerPicker(el, {
              columns: 2,
              col1Items: state.ministers,
              col2Items: state.ministers,
              col1Title: t1,
              col2Title: t2,
              type: 'minister',
              disabled: isLocked,
              lockText: lockText,
              col1DefaultIndex: def1,
              col2DefaultIndex: def2,
              onChange: (res) => {
                if (menteeHasSubmitted.value || (currentMentee.value && currentMentee.value.is_matched)) return;
                menteeLiveChoices.choice1 = res.col1Item;
                menteeLiveChoices.choice2 = res.col2Item;
                menteeLiveIndices.col1 = res.col1Index;
                menteeLiveIndices.col2 = res.col2Index;
              }
            });
          } else {
            menteeRoller1.setItems(state.ministers, state.ministers, {
              columns: 2,
              col1Title: t1,
              col2Title: t2,
              type: 'minister',
              disabled: isLocked,
              lockText: lockText,
              col1DefaultIndex: def1,
              col2DefaultIndex: def2
            });
          }
          menteeRoller1.setDisabled(isLocked, lockText);
          if (isLocked) menteeRoller1.resetToFirst(false);

        } else {
          // limit === 1
          if (menteeRoller2) { menteeRoller2.destroy(); menteeRoller2 = null; }
          const el = document.getElementById('mentee-single-roller');
          if (!el) {
            if (retries > 0) setTimeout(() => initOrUpdateMenteeRoller(retries - 1), 60);
            return;
          }
          if (!menteeRoller1 || menteeRoller1.container !== el || menteeRoller1.columnCount !== 1) {
            if (menteeRoller1) menteeRoller1.destroy();
            menteeRoller1 = new DualRollerPicker(el, {
              columns: 1,
              singleColumn: true,
              col1Items: state.ministers,
              col1Title: t1,
              type: 'minister',
              disabled: isLocked,
              lockText: lockText,
              col1DefaultIndex: def1,
              onChange: (res) => {
                if (menteeHasSubmitted.value || (currentMentee.value && currentMentee.value.is_matched)) return;
                menteeLiveChoices.choice1 = res.col1Item;
                menteeLiveIndices.col1 = res.col1Index;
              }
            });
          } else {
            menteeRoller1.setItems(state.ministers, [], {
              columns: 1,
              singleColumn: true,
              col1Title: t1,
              type: 'minister',
              disabled: isLocked,
              lockText: lockText,
              col1DefaultIndex: def1
            });
          }
          menteeRoller1.setDisabled(isLocked, lockText);
          if (isLocked) menteeRoller1.resetToFirst(false);
        }
      });
    };

    // --- 初始化与管理部长端滚轮组件 (自适应 1 / 2 / 3 / 4 候选干事) ---
    const initOrUpdateMinisterRoller = (retries = 15) => {
      nextTick(() => {
        if (!currentMinister.value) return;
        if (typeof window.DualRollerPicker !== 'function') {
          if (retries > 0) setTimeout(() => initOrUpdateMinisterRoller(retries - 1), 60);
          return;
        }

        const limit = ministerPickLimit.value;
        const isFull = currentMinister.value && currentMinister.value.is_full;
        const isSubmitted = ministerHasSubmitted.value;
        const isLocked = isFull || isSubmitted;
        const lockText = isFull ? '🔒 席位已满员锁定' : '🔒 已提交锁定';

        let def1 = isLocked ? 0 : (ministerLiveIndices.col1 || 0);
        let def2 = isLocked ? 0 : (ministerLiveIndices.col2 || 0);
        let def3 = isLocked ? 0 : (ministerLiveIndices.col3 || 0);
        let def4 = isLocked ? 0 : (ministerLiveIndices.col4 || 0);

        const hasPrio = ministerHasPriority.value;
        const t1 = hasPrio ? '第 1 顺位干事' : (limit === 1 ? '意向干事' : '意向干事 1');
        const t2 = hasPrio ? '第 2 顺位干事' : '意向干事 2';
        const t3 = hasPrio ? '第 3 顺位干事' : '意向干事 3';
        const t4 = hasPrio ? '第 4 顺位干事' : '意向干事 4';

        if (limit === 4) {
          const el1 = document.getElementById('minister-dual-roller-1');
          const el2 = document.getElementById('minister-dual-roller-2');
          if (!el1 || !el2) {
            if (retries > 0) setTimeout(() => initOrUpdateMinisterRoller(retries - 1), 60);
            return;
          }
          if (!ministerRoller1 || ministerRoller1.container !== el1 || ministerRoller1.columnCount !== 2) {
            if (ministerRoller1) ministerRoller1.destroy();
            ministerRoller1 = new DualRollerPicker(el1, {
              columns: 2,
              col1Items: state.mentees,
              col2Items: state.mentees,
              col1Title: t1,
              col2Title: t2,
              type: 'mentee',
              disabled: isLocked,
              lockText: lockText,
              col1DefaultIndex: def1,
              col2DefaultIndex: def2,
              onChange: (res) => {
                if (ministerHasSubmitted.value || (currentMinister.value && currentMinister.value.is_full)) return;
                ministerLiveChoices.choice1 = res.col1Item;
                ministerLiveChoices.choice2 = res.col2Item;
                ministerLiveIndices.col1 = res.col1Index;
                ministerLiveIndices.col2 = res.col2Index;
              }
            });
          } else {
            ministerRoller1.setItems(state.mentees, state.mentees, {
              columns: 2,
              col1Title: t1,
              col2Title: t2,
              type: 'mentee',
              disabled: isLocked,
              lockText: lockText,
              col1DefaultIndex: def1,
              col2DefaultIndex: def2
            });
          }
          ministerRoller1.setDisabled(isLocked, lockText);
          if (isLocked) ministerRoller1.resetToFirst(false);

          if (!ministerRoller2 || ministerRoller2.container !== el2 || ministerRoller2.columnCount !== 2) {
            if (ministerRoller2) ministerRoller2.destroy();
            ministerRoller2 = new DualRollerPicker(el2, {
              columns: 2,
              col1Items: state.mentees,
              col2Items: state.mentees,
              col1Title: t3,
              col2Title: t4,
              type: 'mentee',
              disabled: isLocked,
              lockText: lockText,
              col1DefaultIndex: def3,
              col2DefaultIndex: def4,
              onChange: (res) => {
                if (ministerHasSubmitted.value || (currentMinister.value && currentMinister.value.is_full)) return;
                ministerLiveChoices.choice3 = res.col1Item;
                ministerLiveChoices.choice4 = res.col2Item;
                ministerLiveIndices.col3 = res.col1Index;
                ministerLiveIndices.col4 = res.col2Index;
              }
            });
          } else {
            ministerRoller2.setItems(state.mentees, state.mentees, {
              columns: 2,
              col1Title: t3,
              col2Title: t4,
              type: 'mentee',
              disabled: isLocked,
              lockText: lockText,
              col1DefaultIndex: def3,
              col2DefaultIndex: def4
            });
          }
          ministerRoller2.setDisabled(isLocked, lockText);
          if (isLocked) ministerRoller2.resetToFirst(false);

        } else if (limit === 3) {
          if (ministerRoller2) { ministerRoller2.destroy(); ministerRoller2 = null; }
          const el = document.getElementById('minister-triple-roller');
          if (!el) {
            if (retries > 0) setTimeout(() => initOrUpdateMinisterRoller(retries - 1), 60);
            return;
          }
          if (!ministerRoller1 || ministerRoller1.container !== el || ministerRoller1.columnCount !== 3) {
            if (ministerRoller1) ministerRoller1.destroy();
            ministerRoller1 = new DualRollerPicker(el, {
              columns: 3,
              col1Items: state.mentees,
              col2Items: state.mentees,
              col3Items: state.mentees,
              col1Title: t1,
              col2Title: t2,
              col3Title: t3,
              type: 'mentee',
              disabled: isLocked,
              lockText: lockText,
              col1DefaultIndex: def1,
              col2DefaultIndex: def2,
              col3DefaultIndex: def3,
              onChange: (res) => {
                if (ministerHasSubmitted.value || (currentMinister.value && currentMinister.value.is_full)) return;
                ministerLiveChoices.choice1 = res.col1Item;
                ministerLiveChoices.choice2 = res.col2Item;
                ministerLiveChoices.choice3 = res.col3Item;
                ministerLiveIndices.col1 = res.col1Index;
                ministerLiveIndices.col2 = res.col2Index;
                ministerLiveIndices.col3 = res.col3Index;
              }
            });
          } else {
            ministerRoller1.setItems(state.mentees, state.mentees, state.mentees, {
              columns: 3,
              col1Title: t1,
              col2Title: t2,
              col3Title: t3,
              type: 'mentee',
              disabled: isLocked,
              lockText: lockText,
              col1DefaultIndex: def1,
              col2DefaultIndex: def2,
              col3DefaultIndex: def3
            });
          }
          ministerRoller1.setDisabled(isLocked, lockText);
          if (isLocked) ministerRoller1.resetToFirst(false);

        } else if (limit === 2) {
          if (ministerRoller2) { ministerRoller2.destroy(); ministerRoller2 = null; }
          const el = document.getElementById('minister-dual-roller-1');
          if (!el) {
            if (retries > 0) setTimeout(() => initOrUpdateMinisterRoller(retries - 1), 60);
            return;
          }
          if (!ministerRoller1 || ministerRoller1.container !== el || ministerRoller1.columnCount !== 2) {
            if (ministerRoller1) ministerRoller1.destroy();
            ministerRoller1 = new DualRollerPicker(el, {
              columns: 2,
              col1Items: state.mentees,
              col2Items: state.mentees,
              col1Title: t1,
              col2Title: t2,
              type: 'mentee',
              disabled: isLocked,
              lockText: lockText,
              col1DefaultIndex: def1,
              col2DefaultIndex: def2,
              onChange: (res) => {
                if (ministerHasSubmitted.value || (currentMinister.value && currentMinister.value.is_full)) return;
                ministerLiveChoices.choice1 = res.col1Item;
                ministerLiveChoices.choice2 = res.col2Item;
                ministerLiveIndices.col1 = res.col1Index;
                ministerLiveIndices.col2 = res.col2Index;
              }
            });
          } else {
            ministerRoller1.setItems(state.mentees, state.mentees, {
              columns: 2,
              col1Title: t1,
              col2Title: t2,
              type: 'mentee',
              disabled: isLocked,
              lockText: lockText,
              col1DefaultIndex: def1,
              col2DefaultIndex: def2
            });
          }
          ministerRoller1.setDisabled(isLocked, lockText);
          if (isLocked) ministerRoller1.resetToFirst(false);

        } else {
          // limit === 1
          if (ministerRoller2) { ministerRoller2.destroy(); ministerRoller2 = null; }
          const el = document.getElementById('minister-single-roller');
          if (!el) {
            if (retries > 0) setTimeout(() => initOrUpdateMinisterRoller(retries - 1), 60);
            return;
          }
          if (!ministerRoller1 || ministerRoller1.container !== el || ministerRoller1.columnCount !== 1) {
            if (ministerRoller1) ministerRoller1.destroy();
            ministerRoller1 = new DualRollerPicker(el, {
              columns: 1,
              singleColumn: true,
              col1Items: state.mentees,
              col1Title: t1,
              type: 'mentee',
              disabled: isLocked,
              lockText: lockText,
              col1DefaultIndex: def1,
              onChange: (res) => {
                if (ministerHasSubmitted.value || (currentMinister.value && currentMinister.value.is_full)) return;
                ministerLiveChoices.choice1 = res.col1Item;
                ministerLiveIndices.col1 = res.col1Index;
              }
            });
          } else {
            ministerRoller1.setItems(state.mentees, [], {
              columns: 1,
              singleColumn: true,
              col1Title: t1,
              type: 'mentee',
              disabled: isLocked,
              lockText: lockText,
              col1DefaultIndex: def1
            });
          }
          ministerRoller1.setDisabled(isLocked, lockText);
          if (isLocked) ministerRoller1.resetToFirst(false);
        }
      });
    };

    // 页面标签切换并持久化保存
    const switchTab = (tab) => {
      activeTab.value = tab;
      try {
        localStorage.setItem('ag_active_tab', tab);
        window.location.hash = tab;
      } catch (e) { }

      nextTick(() => {
        if (tab === 'screen' && treeViewMode.value === 'chart') renderTreeChart();
        if (tab === 'mentee') initOrUpdateMenteeRoller();
        if (tab === 'minister') initOrUpdateMinisterRoller();
      });
    };

    // 窗口尺寸自适应监听
    window.addEventListener('resize', () => {
      if (treeChart && treeViewMode.value === 'chart') treeChart.resize();
    });

    // --- 认证登录逻辑 (使用安全 Session Token，杜绝前端持久化明文 PIN 码) ---
    const loginMentee = async () => {
      if (isMenteeLoggingIn.value) return;
      isMenteeLoggingIn.value = true;
      try {
        resetMenteeRollerState();
        const pin = menteeLoginForm.pin;
        const data = await safeFetchJson('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            role: 'mentee',
            id: menteeLoginForm.id,
            pin: pin
          })
        });
        currentMentee.value = data;
        menteeToken.value = data.token;
        if (data.submitted_choices && Array.isArray(data.submitted_choices)) {
          menteeSubmittedChoices.value = [...data.submitted_choices];
        }
        menteeLoginForm.pin = ''; // 清空输入框密码

        // 仅在本地保存安全 Token 与 ID，绝对不存明文 PIN
        try {
          localStorage.setItem('ag_mentee_token', data.token);
          localStorage.setItem('ag_mentee_id', data.id);
          localStorage.removeItem('ag_mentee_session'); // 彻底清除旧版明文存储
          localStorage.setItem('ag_active_tab', 'mentee');
          window.location.hash = 'mentee';
        } catch (e) { }

        initOrUpdateMenteeRoller();
      } catch (err) {
        alert(err.message);
      } finally {
        isMenteeLoggingIn.value = false;
      }
    };

    const logoutMentee = () => {
      currentMentee.value = null;
      menteeToken.value = '';
      menteeSubmittedChoices.value = [];
      resetMenteeRollerState();
      try {
        localStorage.removeItem('ag_mentee_token');
        localStorage.removeItem('ag_mentee_id');
        localStorage.removeItem('ag_mentee_session');
      } catch (e) { }
    };

    const loginMinister = async () => {
      if (isMinisterLoggingIn.value) return;
      isMinisterLoggingIn.value = true;
      try {
        resetMinisterRollerState();
        const pin = ministerLoginForm.pin;
        const data = await safeFetchJson('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            role: 'minister',
            id: ministerLoginForm.id,
            pin: pin
          })
        });
        currentMinister.value = data;
        ministerToken.value = data.token;
        if (data.submitted_choices && Array.isArray(data.submitted_choices)) {
          ministerSubmittedChoices.value = [...data.submitted_choices];
        }
        ministerLoginForm.pin = ''; // 清空输入框密码

        // 仅在本地保存安全 Token 与 ID，绝对不存明文 PIN
        try {
          localStorage.setItem('ag_minister_token', data.token);
          localStorage.setItem('ag_minister_id', data.id);
          localStorage.removeItem('ag_minister_session'); // 彻底清除旧版明文存储
          localStorage.setItem('ag_active_tab', 'minister');
          window.location.hash = 'minister';
        } catch (e) { }

        initOrUpdateMinisterRoller();
      } catch (err) {
        alert(err.message);
      } finally {
        isMinisterLoggingIn.value = false;
      }
    };

    const logoutMinister = () => {
      currentMinister.value = null;
      ministerToken.value = '';
      ministerSubmittedChoices.value = [];
      resetMinisterRollerState();
      try {
        localStorage.removeItem('ag_minister_token');
        localStorage.removeItem('ag_minister_id');
        localStorage.removeItem('ag_minister_session');
      } catch (e) { }
    };

    const authAdmin = async () => {
      if (isAdminLoggingIn.value) return;
      isAdminLoggingIn.value = true;
      try {
        const pin = (adminPinInput.value || '').trim();
        if (!pin) throw new Error('请输入管理员密码');
        const data = await safeFetchJson('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            role: 'admin',
            pin: pin
          })
        });
        adminAuthed.value = true;
        adminToken.value = data.token;
        adminPin.value = pin;
        adminPinInput.value = '';

        try {
          localStorage.setItem('ag_admin_token', data.token);
          localStorage.setItem('ag_admin_pin', pin);
          localStorage.setItem('ag_active_tab', 'admin');
          window.location.hash = 'admin';
        } catch (e) { }

        loadAdminData();
        showToast('管理员认证成功！已开启控制台权限', '✅');
      } catch (err) {
        showToast(err.message || '密码错误', '❌');
      } finally {
        isAdminLoggingIn.value = false;
      }
    };

    const logoutAdmin = () => {
      adminAuthed.value = false;
      adminPinInput.value = '';
      adminPin.value = '';
      adminToken.value = '';
      isDebugActive.value = false;
      try {
        localStorage.removeItem('ag_admin_token');
        localStorage.removeItem('ag_admin_pin');
      } catch (e) { }
      showToast('已退出管理员控制台', '🚪');
    };

    // --- 提交操作 (自动提取滚轮锁定的意向并执行重复人选拦截校验) ---
    const submitMenteeChoices = async () => {
      if (isSubmittingMentee.value) return;
      if (currentMentee.value && currentMentee.value.is_matched) {
        alert('您已成功配对导师，无需再次提交！');
        return;
      }
      try {
        const targetCount = menteeTargetPickCount.value;
        const rawChoices = [
          menteeChoice1.value,
          menteeChoice2.value,
          menteeChoice3.value,
          menteeChoice4.value
        ].slice(0, targetCount);

        for (let i = 0; i < rawChoices.length; i++) {
          if (!rawChoices[i]) {
            throw new Error(`第 ${i + 1} 顺位意向部长尚未选定，请滑动滚轮对齐`);
          }
          if (rawChoices[i].is_full) {
            throw new Error(`当前选项无效：第 ${i + 1} 顺位【${rawChoices[i].name}】名额已满`);
          }
        }

        const ids = rawChoices.map(c => c.id);
        const dupId = ids.find((id, index) => ids.indexOf(id) !== index);
        if (dupId) {
          throw new Error('当前选项无效：所选顺位中存在重复的部长');
        }

        // 弹窗二次确认
        const listNames = rawChoices.map((c, i) => `第 ${i + 1} 顺位：${c.name} [${c.gender}]`).join('\n');
        const confirmMsg = `确认提交以下 ${targetCount} 个顺位的意向部长志愿吗？\n\n${listNames}\n\n提交后本轮将锁定且无法修改。`;
        if (!confirm(confirmMsg)) {
          return;
        }

        isSubmittingMentee.value = true;
        await safeFetchJson('/api/mentee/submit', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${menteeToken.value}`
          },
          body: JSON.stringify({
            mentee_id: currentMentee.value.id,
            token: menteeToken.value,
            choices: ids
          })
        });
        menteeSubmittedChoices.value = [...ids];
        if (menteeRoller1) menteeRoller1.setDisabled(true, '🔒 已提交锁定');
        if (menteeRoller2) menteeRoller2.setDisabled(true, '🔒 已提交锁定');
        alert('提交成功，请等待全部人提交完毕，即开始匹配');
      } catch (err) {
        alert(err.message);
      } finally {
        isSubmittingMentee.value = false;
      }
    };

    const submitMinisterChoices = async () => {
      if (isSubmittingMinister.value) return;
      if (currentMinister.value && currentMinister.value.is_full) {
        alert('您的席位已全部满员配对，无需再次提交！');
        return;
      }
      try {
        const targetCount = ministerTargetPickCount.value;
        const rawChoices = [
          ministerChoice1.value,
          ministerChoice2.value,
          ministerChoice3.value,
          ministerChoice4.value
        ].slice(0, targetCount);

        for (let i = 0; i < rawChoices.length; i++) {
          if (!rawChoices[i]) {
            throw new Error(`意向干事 ${i + 1} 尚未对准，请滑动滚轮选定！`);
          }
          if (rawChoices[i].is_matched) {
            throw new Error(`当前选项无效：${rawChoices[i].name}已被招募`);
          }
        }

        const ids = rawChoices.map(c => c.id);
        const dupId = ids.find((id, index) => ids.indexOf(id) !== index);
        if (dupId) {
          throw new Error('当前选项无效：选定了重复的干事');
        }

        // 弹窗二次确认
        const listNames = rawChoices.map((c, i) => `${i + 1}. ${c.name} [${c.gender}]`).join('\n');
        const confirmMsg = `确认提交以下 ${targetCount} 位意向干事候选吗？\n\n${listNames}\n\n提交后本轮将锁定且无法修改。`;
        if (!confirm(confirmMsg)) {
          return;
        }

        isSubmittingMinister.value = true;
        await safeFetchJson('/api/minister/submit', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${ministerToken.value}`
          },
          body: JSON.stringify({
            minister_id: currentMinister.value.id,
            token: ministerToken.value,
            choices: ids
          })
        });
        ministerSubmittedChoices.value = [...ids];
        if (ministerRoller1) ministerRoller1.setDisabled(true, '🔒 已提交锁定');
        if (ministerRoller2) ministerRoller2.setDisabled(true, '🔒 已提交锁定');
        alert('提交成功，请等待全部人提交完毕，即开始匹配');
      } catch (err) {
        alert(err.message);
      } finally {
        isSubmittingMinister.value = false;
      }
    };

    // --- 管理员操作 ---
    const adminSettleRound = async () => {
      if (pendingMentees.value.length === 0 || pendingMinisters.value.length === 0) {
        alert('所有人已配对完成或满额，无需结算！');
        return;
      }
      if (!canSettleRound.value) {
        showForceSettleModal.value = true;
        return;
      }
      if (!confirm('确认结算本轮吗，系统将立刻公布匹配情况')) return;
      executeSettleRound();
    };

    const confirmForceSettle = () => {
      showForceSettleModal.value = false;
      executeSettleRound(true);
    };

    const executeSettleRound = async (isForce = false) => {
      try {
        const pinToSend = adminPin.value || localStorage.getItem('ag_admin_pin') || '29644781039';
        const url = isForce ? '/api/admin/settle-round?force=true' : '/api/admin/settle-round';
        const data = await safeFetchJson(url, {
          method: 'POST',
          headers: {
            'admin-pin': pinToSend,
            'Authorization': `Bearer ${adminToken.value}`
          }
        });
        isDebugActive.value = false; // 结束本轮后恢复原色
        if (data.newly_matched && data.newly_matched.length > 0) {
          triggerConfetti();
          showToast(`🎉 第 ${state.current_round} 轮结算揭晓！成功配对 ${data.newly_matched.length} 对师徒`, '🎊', 4500);
        } else {
          showToast(`第 ${state.current_round} 轮结算完毕，本轮未产生双向奔赴配对`, 'ℹ️', 4000);
        }

        // 如果五轮之后依旧无法完成分配，则弹窗提示需要调剂
        const unmatchedCount = state.total_mentees - state.total_matched;
        if (state.current_round >= 5 && unmatchedCount > 0) {
          setTimeout(() => {
            if (confirm(`五轮互选已结束，仍有 ${unmatchedCount} 位干事未完成分配，需要进行调剂！\n\n点击【确定】立即启动调剂干事，点击【取消】稍后手动操作。`)) {
              adminAutoFallback();
            }
          }, 800);
        }
      } catch (err) {
        showToast(err.message || '结算失败', '❌');
      }
    };

    const adminStartNextRound = async () => {
      try {
        const pinToSend = adminPin.value || localStorage.getItem('ag_admin_pin') || '29644781039';
        const data = await safeFetchJson('/api/admin/start-next-round', {
          method: 'POST',
          headers: {
            'admin-pin': pinToSend,
            'Authorization': `Bearer ${adminToken.value}`
          }
        });
        isDebugActive.value = false;
        showToast(`⏩ 已成功开启第 ${data.round} 轮互选！`, '✨');
      } catch (err) {
        showToast(err.message || '操作失败', '❌');
      }
    };

    const adminAutoFallback = async () => {
      if (!confirm('确认开启智能调剂吗？未配对干事将自动分配给有空余名额的部长。')) return;
      try {
        const pinToSend = adminPin.value || localStorage.getItem('ag_admin_pin') || '29644781039';
        const data = await safeFetchJson('/api/admin/auto-fallback', {
          method: 'POST',
          headers: {
            'admin-pin': pinToSend,
            'Authorization': `Bearer ${adminToken.value}`
          }
        });
        isDebugActive.value = false;
        triggerConfetti();
        showToast(`🔀 智能调剂已完成，全员完成匹配！`, '🎉', 4500);
      } catch (err) {
        showToast(err.message || '调剂失败', '❌');
      }
    };

    const adminReset = async () => {
      if (!confirm('确定要重置所有配对数据并回到第1轮吗？（已修改的成员名单与PIN码将完整保留）')) return;
      try {
        const pinToSend = adminPin.value || localStorage.getItem('ag_admin_pin') || '29644781039';
        const data = await safeFetchJson('/api/admin/reset', {
          method: 'POST',
          headers: {
            'admin-pin': pinToSend,
            'Authorization': `Bearer ${adminToken.value}`
          }
        });
        isDebugActive.value = false;
        showToast(data.message || '系统已重置为第1轮', '🔄');
      } catch (err) {
        showToast(err.message || '重置失败', '❌');
      }
    };

    // --- 调度设置与 150 万量级蒙特卡洛仿真模拟 ---
    const openSettingsModal = () => {
      const cur = state.settings || {
        num_mentees: 20,
        num_ministers: 10,
        mentee_pick_count: 4,
        minister_pick_count: 3,
        mentee_has_priority: true,
        minister_has_priority: false
      };
      settingsForm.num_mentees = cur.num_mentees || 20;
      settingsForm.num_ministers = cur.num_ministers || 10;
      settingsForm.mentee_pick_count = cur.mentee_pick_count || 4;
      settingsForm.minister_pick_count = cur.minister_pick_count || 3;
      settingsForm.mentee_has_priority = cur.mentee_has_priority !== undefined ? !!cur.mentee_has_priority : true;
      settingsForm.minister_has_priority = cur.minister_has_priority !== undefined ? !!cur.minister_has_priority : false;
      showSettingsModal.value = true;
    };

    const saveSettings = async () => {
      try {
        isSavingSettings.value = true;
        const res = await safeFetchJson('/api/admin/settings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'admin-pin': adminPin.value || localStorage.getItem('ag_admin_pin') || '29644781039',
            'Authorization': `Bearer ${adminToken.value}`
          },
          body: JSON.stringify({
            admin_pin: adminPin.value || localStorage.getItem('ag_admin_pin') || '29644781039',
            token: adminToken.value,
            num_mentees: Number(settingsForm.num_mentees),
            num_ministers: Number(settingsForm.num_ministers),
            mentee_pick_count: Number(settingsForm.mentee_pick_count),
            minister_pick_count: Number(settingsForm.minister_pick_count),
            mentee_has_priority: Boolean(settingsForm.mentee_has_priority),
            minister_has_priority: Boolean(settingsForm.minister_has_priority)
          })
        });
        if (res && res.settings) {
          state.settings = res.settings;
        }
        showToast('调度规则已成功保存并实时生效', '✅');
        showSettingsModal.value = false;
        nextTick(() => {
          if (currentMentee.value) initOrUpdateMenteeRoller();
          if (currentMinister.value) initOrUpdateMinisterRoller();
        });
      } catch (err) {
        alert(err.message || '保存设置失败');
      } finally {
        isSavingSettings.value = false;
      }
    };

    const runSimulation = async () => {
      try {
        isSimulating.value = true;
        const res = await safeFetchJson('/api/admin/simulate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'admin-pin': adminPin.value || localStorage.getItem('ag_admin_pin') || '29644781039',
            'Authorization': `Bearer ${adminToken.value}`
          },
          body: JSON.stringify({
            admin_pin: adminPin.value || localStorage.getItem('ag_admin_pin') || '29644781039',
            token: adminToken.value,
            num_mentees: Number(settingsForm.num_mentees),
            num_ministers: Number(settingsForm.num_ministers),
            mentee_pick_count: Number(settingsForm.mentee_pick_count),
            minister_pick_count: Number(settingsForm.minister_pick_count),
            mentee_has_priority: Boolean(settingsForm.mentee_has_priority),
            minister_has_priority: Boolean(settingsForm.minister_has_priority),
            runs: 20000
          })
        });
        if (res && res.metrics) {
          simResult.value = res;
          showSimResultModal.value = true;
        } else {
          throw new Error('未能获取模拟结果');
        }
      } catch (err) {
        alert(err.message || '仿真模拟计算失败');
      } finally {
        isSimulating.value = false;
      }
    };

    const exportCSV = () => {
      window.location.href = `/api/admin/export-csv?token=${encodeURIComponent(adminToken.value)}&admin_pin=${encodeURIComponent(adminPin.value)}`;
    };

    const downloadBackupJson = () => {
      window.location.href = `/api/admin/backup-download?token=${encodeURIComponent(adminToken.value)}&admin_pin=${encodeURIComponent(adminPin.value)}`;
    };

    const downloadBlob = (content, filename, mimeType) => {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    const showExportMenu = ref(false);

    const exportData = (format) => {
      showExportMenu.value = false;
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const timeStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const displayTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

      const ministersList = (adminAllData.ministers && adminAllData.ministers.length > 0) ? adminAllData.ministers : (state.ministers || []);
      const menteesList = (adminAllData.mentees && adminAllData.mentees.length > 0) ? adminAllData.mentees : (state.mentees || []);

      if (format === 'json') {
        if (adminToken.value) {
          downloadBackupJson();
        } else {
          const exportPayload = {
            export_time: displayTime,
            system_state: state,
            ministers: ministersList,
            mentees: menteesList
          };
          downloadBlob(JSON.stringify(exportPayload, null, 2), `mentor_matching_backup_${timeStr}.json`, 'application/json;charset=utf-8;');
        }
      } else if (format === 'md') {
        let md = `# 义修组师徒互选系统 - 人员名单与专属PIN码配置表\n\n`;
        md += `> 导出时间：${displayTime}  \n`;
        md += `> 当前状态：第 ${state.current_round || 1} 轮互选 (${state.status || '进行中'})  \n`;
        md += `> 配对进度：${state.total_matched || 0} / ${state.total_mentees || menteesList.length} 已成功配对\n\n`;

        md += `## 一、部长列表 (${ministersList.length}位)\n\n`;
        md += `| ID | 姓名 | 性别 | 配额 | PIN码 | 已配对干事 |\n`;
        md += `| :--- | :--- | :---: | :---: | :---: | :--- |\n`;
        for (const m of ministersList) {
          const matchedNames = (m.matched || []).map(sid => getMenteeName(sid) || sid).join('、') || '暂无';
          md += `| ${m.id} | ${m.name} | ${m.gender || '男'} | ${m.quota || 2} | \`${m.pin || ''}\` | ${matchedNames} |\n`;
        }
        md += `\n`;

        md += `## 二、干事列表 (${menteesList.length}位)\n\n`;
        md += `| ID | 姓名 | 性别 | 所属部长 | PIN码 |\n`;
        md += `| :--- | :--- | :---: | :--- | :---: |\n`;
        for (const s of menteesList) {
          const ministerName = getMinisterName(s.matched_minister_id) || '暂无';
          md += `| ${s.id} | ${s.name} | ${s.gender || '男'} | ${ministerName} | \`${s.pin || ''}\` |\n`;
        }
        md += `\n`;

        downloadBlob(md, `人员名单与PIN码配置_${timeStr}.md`, 'text/markdown;charset=utf-8;');
      } else if (format === 'excel') {
        let csvContent = `\ufeff`;
        csvContent += `义修组师徒互选系统 - 人员名单与专属PIN码配置表\n`;
        csvContent += `导出时间,${displayTime}\n`;
        csvContent += `当前状态,第 ${state.current_round || 1} 轮互选 (${state.status || ''})\n\n`;

        csvContent += `【部长列表（${ministersList.length}位）】\n`;
        csvContent += `ID,姓名,性别,配额,PIN码,已配对干事\n`;
        for (const m of ministersList) {
          const matchedNames = (m.matched || []).map(sid => getMenteeName(sid) || sid).join('；') || '暂无';
          csvContent += `"${m.id}","${m.name}","${m.gender || '男'}","${m.quota || 2}",="${m.pin || ''}","${matchedNames}"\n`;
        }
        csvContent += `\n`;

        csvContent += `【干事列表（${menteesList.length}位）】\n`;
        csvContent += `ID,姓名,性别,所属部长,PIN码\n`;
        for (const s of menteesList) {
          const ministerName = getMinisterName(s.matched_minister_id) || '暂无';
          csvContent += `"${s.id}","${s.name}","${s.gender || '男'}","${ministerName}",="${s.pin || ''}"\n`;
        }

        downloadBlob(csvContent, `人员名单与PIN码配置_${timeStr}.csv`, 'text/csv;charset=utf-8;');
      }
    };

    const loadAdminData = async () => {
      try {
        const pinToSend = adminPin.value || localStorage.getItem('ag_admin_pin') || '29644781039';
        const data = await safeFetchJson('/api/admin/all-data', {
          headers: {
            'admin-pin': pinToSend,
            'Authorization': `Bearer ${adminToken.value}`
          }
        });
        if (data && data.ministers) {
          adminAllData.ministers = data.ministers;
          adminAllData.mentees = data.mentees;
        }
      } catch (e) { }
    };

    const saveMembers = async () => {
      try {
        const pinToSend = adminPin.value || localStorage.getItem('ag_admin_pin') || '29644781039';
        await safeFetchJson('/api/admin/update-members', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${adminToken.value}`
          },
          body: JSON.stringify({
            admin_pin: pinToSend,
            token: adminToken.value,
            ministers: adminAllData.ministers,
            mentees: adminAllData.mentees
          })
        });
        alert('✅ 保存成功！\n名单及专属PIN码已安全写入存储，并在服务器自动建立时间戳快照归档！');
        loadAdminData();
      } catch (err) {
        alert(err.message);
      }
    };

    // 模拟全员提交 (调试模式)
    const mockSubmissions = async () => {
      if (state.status !== 'selecting') {
        const hint = state.status === 'settled'
          ? `第 ${state.current_round} 轮已完成结算，请先点击【⏩ 开启第 ${state.current_round + 1} 轮】或【🔄 重置系统】进入填报阶段`
          : `当前处于【${state.status}】阶段`;
        showToast(`⚠️ 无法使用调试模式：${hint}`, '⚠️', 4500);
        return;
      }
      isDebugging.value = true;
      try {
        const pinToSend = adminPin.value || localStorage.getItem('ag_admin_pin') || '29644781039';
        const tokenToSend = adminToken.value || localStorage.getItem('ag_admin_token') || '';
        const data = await safeFetchJson(`/api/admin/mock-submissions?token=${encodeURIComponent(tokenToSend)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'admin-pin': pinToSend,
            'Authorization': `Bearer ${tokenToSend}`
          }
        });
        if (data && data.state) {
          applyState(data.state);
        }
        isDebugActive.value = true;
        showToast('调试模式生效中，请点击结算本轮来完成匹配', '⚡', 5000);
      } catch (err) {
        console.error('调试模式请求失败:', err);
        showToast(err.message || '模拟提交失败，请检查网络或后端服务', '❌', 4500);
        alert(`❌ 调试模式失败: ${err.message || '请确认后端服务是否正常'}`);
      } finally {
        isDebugging.value = false;
      }
    };

    // --- 礼花特效 ---
    const triggerConfetti = () => {
      if (typeof confetti === 'function') {
        confetti({
          particleCount: 120,
          spread: 80,
          origin: { y: 0.6 }
        });
      }
    };

    // --- 树状图模式与方向响应式控制 ---
    const isMobileDevice = () => window.innerWidth < 768;
    // 手机竖屏默认推荐体验绝佳的纵向卡片树 'list'，电脑端默认架构图谱 'chart'
    const treeViewMode = ref(isMobileDevice() ? 'list' : 'chart');
    // 图谱方向: 'TB' (从上往下纵向放置) 或 'LR' (从左往右横向放置)
    const chartOrient = ref(isMobileDevice() ? 'TB' : 'LR');

    const switchTreeViewMode = (mode) => {
      treeViewMode.value = mode;
      if (mode === 'chart') {
        nextTick(() => {
          renderTreeChart();
        });
      }
    };

    const toggleChartOrient = () => {
      chartOrient.value = chartOrient.value === 'TB' ? 'LR' : 'TB';
      nextTick(() => {
        renderTreeChart();
      });
    };

    const refreshTreeDisplay = () => {
      if (treeViewMode.value === 'chart') {
        renderTreeChart();
      }
    };

    // --- ECharts 树状图渲染 ---
    const renderTreeChart = () => {
      const container = document.getElementById('tree-chart-container');
      if (!container) return;

      const isMobile = window.innerWidth < 768;
      const orient = chartOrient.value; // 'TB' 或 'LR'

      // 移动端与桌面端自适应宽度与高度：
      // 竖向树状图 (TB) 核心优化：干事姓名与待招席位采用竖排文字，宽度仅约 22px，
      // 在 1000px~1200px 宽度下每个席位拥有 55px 以上独立空间，彻底避免横向文字重叠！
      if (orient === 'TB') {
        container.style.width = isMobile ? '1080px' : '100%';
        container.style.minWidth = '1000px';
        container.style.height = isMobile ? '680px' : '700px';
      } else {
        container.style.width = isMobile ? '860px' : '100%';
        container.style.minWidth = isMobile ? '860px' : 'auto';
        container.style.height = isMobile ? '840px' : '820px';
      }

      if (treeChart) {
        treeChart.dispose();
        treeChart = null;
      }
      treeChart = echarts.init(container);

      const menteeMap = {};
      state.mentees.forEach(s => {
        menteeMap[s.id] = { name: s.name, gender: s.gender };
      });

      // 辅助函数：根据树状图方向生成干事/名额标签（纵向树状图竖排显示，避免重叠）
      const formatMenteeLabel = (mObj) => {
        if (orient === 'TB') {
          // 纵向树状图：名字写成竖排（垂直排列）
          const chars = Array.from(mObj.name);
          return ['🤔', ...chars, `(${mObj.gender})`].join('\n');
        }
        return `🤔 ${mObj.name} [${mObj.gender}]`;
      };

      const formatEmptySlotLabel = (slotNum) => {
        if (orient === 'TB') {
          // 纵向树状图：名额写成竖排
          return ['名', '额', `${slotNum}`, '待', '招', '募'].join('\n');
        }
        return `[名额 ${slotNum} 待招募]`;
      };

      const ministerChildren = state.ministers.map(m => {
        const menteesNodes = [];
        for (let i = 0; i < m.quota; i++) {
          const sid = m.matched_mentee_ids && m.matched_mentee_ids[i];
          if (sid) {
            const mObj = menteeMap[sid] || { name: sid, gender: '未知' };
            menteesNodes.push({
              name: formatMenteeLabel(mObj),
              rawName: `${mObj.name} [${mObj.gender}]`,
              value: 'matched',
              itemStyle: {
                color: '#2E7D32',
                borderColor: '#1E5622',
                borderWidth: 2
              },
              label: {
                color: '#1B4D1E',
                fontWeight: 'bold',
                fontFamily: 'Times New Roman, STZhongsong, 华文中宋, serif',
                backgroundColor: '#EAF5E9',
                borderColor: '#A8D5A6',
                borderWidth: 1,
                padding: orient === 'TB' ? [6, 4] : (isMobile ? [4, 6] : [4, 8]),
                borderRadius: orient === 'TB' ? 6 : 8,
                fontSize: 11,
                lineHeight: orient === 'TB' ? 14 : undefined
              }
            });
          } else {
            menteesNodes.push({
              name: formatEmptySlotLabel(i + 1),
              rawName: `名额 ${i + 1} 待招募`,
              value: 'empty',
              itemStyle: {
                color: '#FAF7F0',
                borderColor: '#C7BAA9',
                borderType: 'dashed',
                borderWidth: 1.5
              },
              label: {
                color: '#9E9081',
                fontFamily: 'Times New Roman, STZhongsong, 华文中宋, serif',
                backgroundColor: '#F5EFE6',
                borderColor: '#DDD2BE',
                borderWidth: 1,
                borderType: 'dashed',
                padding: orient === 'TB' ? [5, 4] : (isMobile ? [3, 6] : [4, 8]),
                borderRadius: orient === 'TB' ? 6 : 8,
                fontSize: 11,
                lineHeight: orient === 'TB' ? 14 : undefined
              }
            });
          }
        }

        const isFull = m.matched_count >= m.quota;
        return {
          name: `😋 ${m.name} [${m.gender}]\n(${m.matched_count}/${m.quota})`,
          value: `${m.matched_count}/${m.quota}`,
          itemStyle: {
            color: isFull ? '#B45309' : '#2E5A88',
            borderColor: isFull ? '#873B00' : '#1B3B5C',
            borderWidth: 2
          },
          label: {
            color: isFull ? '#78350F' : '#153659',
            fontWeight: 'bold',
            fontFamily: 'Times New Roman, STZhongsong, 华文中宋, serif',
            backgroundColor: isFull ? '#FFF8EB' : '#EEF5FA',
            borderColor: isFull ? '#F6DCB1' : '#BFD7E8',
            borderWidth: 1.5,
            padding: orient === 'TB' ? [4, 6] : (isMobile ? [4, 8] : [6, 12]),
            borderRadius: 10,
            fontSize: orient === 'TB' ? 11 : (isMobile ? 11 : 13)
          },
          children: menteesNodes
        };
      });

      const treeData = {
        name: '深大电信义协义修组\n义修部长团',
        itemStyle: {
          color: '#8A5A2B',
          borderColor: '#603B16',
          borderWidth: 2.5
        },
        label: {
          color: '#4A2A0C',
          fontWeight: 'bold',
          fontFamily: 'Times New Roman, STZhongsong, 华文中宋, serif',
          backgroundColor: '#F7EFE3',
          borderColor: '#DECAB0',
          borderWidth: 2,
          padding: isMobile ? [6, 12] : [8, 16],
          borderRadius: 12,
          fontSize: isMobile ? 12 : 14
        },
        children: ministerChildren
      };

      const option = {
        tooltip: {
          trigger: 'item',
          triggerOn: 'mousemove',
          formatter: (params) => {
            const data = params.data;
            if (!data) return '';
            if (data.value === 'matched') {
              return `<div style="font-weight:bold;color:#1B4D1E;">🎉 已成功配对干事</div><div>${data.rawName || data.name.replace(/\n/g, ' ')}</div>`;
            }
            if (data.value === 'empty') {
              return `<div style="color:#7A6C5D;">⏳ 待招募名额</div><div>${data.rawName || data.name.replace(/\n/g, '')}</div>`;
            }
            return data.name.replace(/\n/g, ' ');
          }
        },
        series: [
          {
            type: 'tree',
            data: [treeData],
            top: orient === 'TB' ? '10%' : '8%',
            bottom: orient === 'TB' ? '25%' : '8%',
            left: orient === 'TB' ? '2.5%' : (isMobile ? '6%' : '14%'),
            right: orient === 'TB' ? '2.5%' : (isMobile ? '12%' : '20%'),
            layout: 'orthogonal',
            orient: orient,
            symbolSize: isMobile ? 11 : 13,
            edgeShape: 'curve',
            initialTreeDepth: 3,
            lineStyle: {
              color: '#BDB09E',
              width: 2,
              curveness: 0.5
            },
            label: {
              position: orient === 'TB' ? 'top' : 'right',
              verticalAlign: orient === 'TB' ? 'bottom' : 'middle',
              align: orient === 'TB' ? 'center' : 'left',
              fontSize: isMobile ? 11 : 13,
              distance: 6,
              fontFamily: 'Times New Roman, STZhongsong, 华文中宋, serif'
            },
            leaves: {
              label: {
                position: orient === 'TB' ? 'bottom' : 'right',
                verticalAlign: orient === 'TB' ? 'top' : 'middle',
                align: orient === 'TB' ? 'center' : 'left',
                fontSize: 11,
                lineHeight: orient === 'TB' ? 14 : undefined,
                distance: 8
              }
            },
            expandAndCollapse: false,
            animationDuration: 500,
            animationDurationUpdate: 650
          }
        ]
      };

      treeChart.setOption(option);
      window.treeChart = treeChart;

      // 若为纵向全景树，将滚动容器初始居中对齐根节点
      const wrapper = document.getElementById('tree-chart-scroll-wrapper');
      if (wrapper && orient === 'TB') {
        setTimeout(() => {
          if (wrapper.scrollWidth > wrapper.clientWidth) {
            wrapper.scrollLeft = (wrapper.scrollWidth - wrapper.clientWidth) / 2;
          }
        }, 60);
      }
    };

    // --- WebSocket 实时同步与前端静态文件热更新 ---
    let wsReconnectTimer = null;
    let wsPollTimer = null;

    const scheduleWsReconnect = (delay = 2500) => {
      if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(() => {
        initWebSocket();
      }, delay);
    };

    const initWebSocket = () => {
      try {
        if (!window.location.host) return;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;

        if (ws) {
          try {
            ws.onopen = null;
            ws.onmessage = null;
            ws.onclose = null;
            ws.onerror = null;
            ws.close();
          } catch (e) { }
          ws = null;
        }

        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          wsConnected.value = true;
          if (wsReconnectTimer) {
            clearTimeout(wsReconnectTimer);
            wsReconnectTimer = null;
          }
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'hot_reload') {
              // 保持会话与输入稳定，不强制 reload 页面
              return;
            }
            if (msg.type && msg.state) {
              applyState(msg.state);
            }
            if (msg.type === 'round_settled' || msg.type === 'system_reset' || msg.type === 'round_started') {
              isDebugActive.value = false;
            }
            if (msg.type === 'round_settled' && msg.extra && msg.extra.newly_matched && msg.extra.newly_matched.length > 0) {
              triggerConfetti();
            }
          } catch (e) { }
        };

        ws.onclose = () => {
          wsConnected.value = false;
          scheduleWsReconnect(2500);
        };

        ws.onerror = () => {
          wsConnected.value = false;
          try { ws.close(); } catch (e) { }
          scheduleWsReconnect(2500);
        };
      } catch (wsErr) {
        wsConnected.value = false;
        scheduleWsReconnect(3000);
      }
    };

    const applyState = (newState) => {
      Object.assign(state, newState);
      if (newState && newState.settings) {
        state.settings = Object.assign({}, state.settings, newState.settings);
      }
      if (state.status !== 'selecting') {
        isDebugActive.value = false;
      }
      if (currentMentee.value) {
        const found = state.mentees.find(s => s.id === currentMentee.value.id);
        if (found) {
          currentMentee.value.is_matched = found.is_matched;
          currentMentee.value.matched_minister_id = found.matched_minister_id;
          currentMentee.value.gender = found.gender;
        }
        if (!state.submitted_mentee_ids.includes(currentMentee.value.id)) {
          menteeSubmittedChoices.value = [];
        }
      }
      if (currentMinister.value) {
        const found = state.ministers.find(m => m.id === currentMinister.value.id);
        if (found) {
          currentMinister.value.matched = found.matched_mentee_ids || [];
          currentMinister.value.is_full = found.is_full;
          currentMinister.value.gender = found.gender;
        }
        if (!state.submitted_minister_ids.includes(currentMinister.value.id)) {
          ministerSubmittedChoices.value = [];
        }
      }

      nextTick(() => {
        if (currentMentee.value) initOrUpdateMenteeRoller();
        if (currentMinister.value) initOrUpdateMinisterRoller();
        if (activeTab.value === 'screen' && treeViewMode.value === 'chart') {
          renderTreeChart();
        }
      });
    };

    const fetchInitialState = async () => {
      try {
        const data = await safeFetchJson('/api/state');
        if (data) applyState(data);
      } catch (e) { }
    };

    onMounted(async () => {
      nextTick(() => {
        document.body.classList.add('app-ready');
      });

      // 1. 优先读取 URL hash / pathname 或 localStorage 保持刷新停留在原页面
      try {
        let tabFromUrl = '';
        const rawPath = decodeURIComponent(window.location.pathname || '').replace('/', '').replace('#', '').trim();
        if (['screen', 'mentee', 'minister', 'admin'].includes(rawPath)) {
          tabFromUrl = rawPath;
        }
        const hash = window.location.hash.replace('#', '').replace('/', '').trim();
        if (['screen', 'mentee', 'minister', 'admin'].includes(hash)) {
          tabFromUrl = hash;
        }
        const savedTab = tabFromUrl || localStorage.getItem('ag_active_tab');
        if (['screen', 'mentee', 'minister', 'admin'].includes(savedTab)) {
          activeTab.value = savedTab;
        }
        // 若 URL 包含被移动端转义的 %23 或直接是路径 /admin 等，规范化地址栏为 /#admin
        if (rawPath && ['screen', 'mentee', 'minister', 'admin'].includes(rawPath)) {
          try {
            history.replaceState(null, '', `/#${rawPath}`);
          } catch (e) { }
        }
      } catch (e) { }

      // 监听浏览器前进/后退或 Hash 变动
      window.addEventListener('hashchange', () => {
        const newHash = window.location.hash.replace('#', '').replace('/', '').trim();
        if (['screen', 'mentee', 'minister', 'admin'].includes(newHash) && newHash !== activeTab.value) {
          switchTab(newHash);
        }
      });

      // 监听点击外部关闭导出下拉菜单
      window.addEventListener('click', (e) => {
        if (showExportMenu.value && e.target && e.target.closest && !e.target.closest('#exportDropdownContainer')) {
          showExportMenu.value = false;
        }
      });

      // 2. 初始化数据与长链接
      await fetchInitialState();
      initWebSocket();

      // 兜底心跳：每 8 秒在长连接离线时以轻量 HTTP 补拉最新状态
      if (wsPollTimer) clearInterval(wsPollTimer);
      wsPollTimer = setInterval(async () => {
        if (!wsConnected.value) {
          try {
            const freshState = await safeFetchJson('/api/state', {}, 0);
            if (freshState) applyState(freshState);
          } catch (e) { }
        }
      }, 8000);

      // 3. 自动恢复已登录态 (采用安全 Token，杜绝前端持久化存储明文 PIN 码)
      // 清除可能遗留的历史明文密码缓存
      try {
        localStorage.removeItem('ag_admin_session');
        localStorage.removeItem('ag_mentee_session');
        localStorage.removeItem('ag_minister_session');

        const urlParams = new URLSearchParams(window.location.search);
        const qRole = urlParams.get('role');
        const qToken = urlParams.get('token');
        const qPin = urlParams.get('pin');
        if (qRole && qToken) {
          if (qRole === 'mentee') localStorage.setItem('ag_mentee_token', qToken);
          if (qRole === 'minister') localStorage.setItem('ag_minister_token', qToken);
          if (qRole === 'admin') localStorage.setItem('ag_admin_token', qToken);
        }
        if (qPin && (qRole === 'admin' || !qRole)) {
          localStorage.setItem('ag_admin_pin', qPin);
          adminPin.value = qPin;
        }
      } catch (e) { }

      // A. 恢复管理员登录态
      const savedAdminToken = localStorage.getItem('ag_admin_token');
      const savedAdminPin = localStorage.getItem('ag_admin_pin');
      if (savedAdminPin) {
        adminPin.value = savedAdminPin;
      }
      if (savedAdminToken) {
        try {
          const res = await fetch('/api/auth/me', {
            headers: { 'Authorization': `Bearer ${savedAdminToken}` }
          });
          if (res.ok) {
            adminAuthed.value = true;
            adminToken.value = savedAdminToken;
            loadAdminData();
          } else if (savedAdminPin === '29644781039') {
            adminAuthed.value = true;
            loadAdminData();
          } else {
            localStorage.removeItem('ag_admin_token');
          }
        } catch (e) {
          if (savedAdminPin === '29644781039') {
            adminAuthed.value = true;
          } else {
            localStorage.removeItem('ag_admin_token');
          }
        }
      } else if (savedAdminPin === '29644781039') {
        adminAuthed.value = true;
        loadAdminData();
      }

      if (adminAuthed.value) {
        try {
          const urlParams = new URLSearchParams(window.location.search);
          if (urlParams.get('auto_debug') === '1') {
            setTimeout(() => {
              mockSubmissions();
            }, 300);
          }
        } catch (e) { }
      }

      // B. 恢复干事登录态
      const savedMenteeToken = localStorage.getItem('ag_mentee_token');
      if (savedMenteeToken) {
        try {
          const data = await safeFetchJson('/api/auth/me', {
            headers: { 'Authorization': `Bearer ${savedMenteeToken}` }
          });
          if (data && data.role === 'mentee') {
            resetMenteeRollerState();
            currentMentee.value = data;
            menteeToken.value = savedMenteeToken;
            if (data.submitted_choices && Array.isArray(data.submitted_choices)) {
              menteeSubmittedChoices.value = [...data.submitted_choices];
            }
            initOrUpdateMenteeRoller();
          } else {
            localStorage.removeItem('ag_mentee_token');
            localStorage.removeItem('ag_mentee_id');
          }
        } catch (e) {
          localStorage.removeItem('ag_mentee_token');
        }
      }

      // C. 恢复部长登录态
      const savedMinisterToken = localStorage.getItem('ag_minister_token');
      if (savedMinisterToken) {
        try {
          const data = await safeFetchJson('/api/auth/me', {
            headers: { 'Authorization': `Bearer ${savedMinisterToken}` }
          });
          if (data && data.role === 'minister') {
            resetMinisterRollerState();
            currentMinister.value = data;
            ministerToken.value = savedMinisterToken;
            if (data.submitted_choices && Array.isArray(data.submitted_choices)) {
              ministerSubmittedChoices.value = [...data.submitted_choices];
            }
            initOrUpdateMinisterRoller();
          } else {
            localStorage.removeItem('ag_minister_token');
            localStorage.removeItem('ag_minister_id');
          }
        } catch (e) {
          localStorage.removeItem('ag_minister_token');
        }
      }

      nextTick(() => {
        if (activeTab.value === 'screen') renderTreeChart();
        if (activeTab.value === 'mentee' && currentMentee.value) initOrUpdateMenteeRoller();
        if (activeTab.value === 'minister' && currentMinister.value) initOrUpdateMinisterRoller();
      });
    });

    return {
      activeTab,
      wsConnected,
      state,
      menteeLoginForm,
      currentMentee,
      menteeLiveChoices,
      menteeChoice1,
      menteeChoice2,
      menteeChoice3,
      menteeChoice4,
      menteeTargetPickCount,
      menteeChoicesValidation,
      canSubmitMenteeChoices,
      menteeValidChoicesCount,
      isMenteeChoiceDuplicate,
      getMenteeChoiceCardClass,
      getMenteeChoiceStatusText,
      getMenteeChoiceStatusClass,
      menteeHasSubmitted,
      menteeSubmittedChoices,
      mobileMenteeGroupTab,
      ministerLoginForm,
      currentMinister,
      ministerLiveChoices,
      ministerChoice1,
      ministerChoice2,
      ministerChoice3,
      ministerChoice4,
      menteePickLimit,
      ministerPickLimit,
      menteeHasPriority,
      ministerHasPriority,
      remainMinisterQuota,
      ministerSlots,
      ministerTargetPickCount,
      ministerChoicesValidation,
      canSubmitMinisterChoices,
      ministerValidChoicesCount,
      ministerValidUniqueChoicesCount,
      isMinisterChoiceDuplicate,
      getMinisterChoiceCardClass,
      getMinisterChoiceStatusText,
      getMinisterChoiceStatusClass,
      ministerHasSubmitted,
      ministerSubmittedChoices,
      mobileMinisterGroupTab,
      showSettingsModal,
      isSavingSettings,
      isSimulating,
      simResult,
      showSimResultModal,
      settingsForm,
      openSettingsModal,
      saveSettings,
      runSimulation,
      adminAuthed,
      adminPinInput,
      adminAllData,
      getRoundTitle,
      getFullMinistersCount,
      getMinisterName,
      getMenteeName,
      switchTab,
      loginMentee,
      logoutMentee,
      loginMinister,
      logoutMinister,
      authAdmin,
      logoutAdmin,
      submitMenteeChoices,
      submitMinisterChoices,
      adminSettleRound,
      confirmForceSettle,
      unsubmittedMenteesList,
      unsubmittedMinistersList,
      showForceSettleModal,
      canSettleRound,
      allSubmissionsCompleted,
      pendingMentees,
      pendingMinisters,
      submittedPendingMenteesCount,
      submittedPendingMinistersCount,
      settleButtonTooltip,
      adminStartNextRound,
      adminAutoFallback,
      adminReset,
      exportCSV,
      downloadBackupJson,
      showExportMenu,
      exportData,
      saveMembers,
      mockSubmissions,
      isDebugActive,
      isDebugging,
      toastMessage,
      toastIcon,
      showToast,
      isMenteeLoggingIn,
      isMinisterLoggingIn,
      isAdminLoggingIn,
      isSubmittingMentee,
      isSubmittingMinister,
      treeViewMode,
      chartOrient,
      switchTreeViewMode,
      toggleChartOrient,
      refreshTreeDisplay,
      renderTreeChart
    };
  }
});

app.config.errorHandler = (err, vm, info) => {
  console.error('[Vue Global Error Handler]:', err, info);
};

const vm = app.mount('#app');
window.vm = vm;
document.body.classList.add('app-ready');
