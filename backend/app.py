import os
import json
import csv
import io
import time
import secrets
import uuid
import asyncio
import random
from datetime import datetime
from typing import List, Dict, Optional, Any
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends, Header, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, Response, StreamingResponse, FileResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from pydantic import BaseModel
from simulator import run_simulation

app = FastAPI(title="师徒制双向互选配对系统")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class NoCacheASGIMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            path = scope.get("path", "")
            if path == "/" or path.endswith((".html", ".js", ".css", ".json")):
                async def send_wrapper(message):
                    if message["type"] == "http.response.start":
                        headers = list(message.get("headers", []))
                        headers = [h for h in headers if h[0].lower() not in (b"cache-control", b"pragma", b"expires")]
                        headers.extend([
                            (b"cache-control", b"no-cache, no-store, must-revalidate, max-age=0"),
                            (b"pragma", b"no-cache"),
                            (b"expires", b"0")
                        ])
                        message["headers"] = headers
                    await send(message)
                await self.app(scope, receive, send_wrapper)
                return
        await self.app(scope, receive, send)

app.add_middleware(NoCacheASGIMiddleware)

@app.exception_handler(StarletteHTTPException)
async def custom_http_exception_handler(request: Request, exc: StarletteHTTPException):
    if exc.status_code == 404:
        path = request.url.path
        # 兼容单页面应用 (SPA) 路由及被移动端浏览器编码的 /%23admin 等路径
        if not path.startswith("/api/") and not any(path.lower().endswith(ext) for ext in [".js", ".css", ".png", ".jpg", ".jpeg", ".ico", ".svg", ".json", ".csv", ".woff", ".woff2", ".ttf"]):
            index_path = os.path.join(STATIC_DIR, "index.html")
            if os.path.exists(index_path):
                response = FileResponse(index_path, media_type="text/html")
                response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
                response.headers["Pragma"] = "no-cache"
                response.headers["Expires"] = "0"
                return response
    return Response(
        content=json.dumps({"detail": exc.detail}),
        status_code=exc.status_code,
        media_type="application/json"
    )

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")
STATE_FILE = os.path.join(DATA_DIR, "state.json")
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

ADMIN_PIN = "29644781039"

# Session Token 会话持久化存储，保障服务器热更新或重启后管理员与成员登录态不失效
SESSION_FILE = os.path.join(DATA_DIR, "sessions.json")

def load_sessions() -> Dict[str, Dict[str, Any]]:
    if os.path.exists(SESSION_FILE):
        try:
            with open(SESSION_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def _do_save_sessions(sessions_copy: Dict[str, Dict[str, Any]]):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp_file = SESSION_FILE + f".tmp_{os.getpid()}_{time.time_ns()}_{uuid.uuid4().hex[:6]}"
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(sessions_copy, f, ensure_ascii=False)
        os.replace(tmp_file, SESSION_FILE)
    except Exception as e:
        print(f"[警告] sessions 保存失败: {e}")

def save_sessions(sessions: Dict[str, Dict[str, Any]]):
    # 非阻塞线程池写入，确保 /api/auth/login 亚毫秒极速响应
    try:
        loop = asyncio.get_running_loop()
        loop.run_in_executor(None, _do_save_sessions, dict(sessions))
    except Exception:
        _do_save_sessions(dict(sessions))

SESSIONS: Dict[str, Dict[str, Any]] = load_sessions()

DEFAULT_SETTINGS: Dict[str, Any] = {
    "num_mentees": 20,
    "num_ministers": 10,
    "mentee_pick_count": 4,
    "minister_pick_count": 3,
    "mentee_has_priority": True,
    "minister_has_priority": False,
}

# 默认初始化数据 (10位部长，20位干事，无部门，带性别与PIN)
def get_default_state() -> Dict[str, Any]:
    ministers = [
        {"id": "m1", "name": "陈部长", "gender": "男", "quota": 2, "pin": "1111", "matched": []},
        {"id": "m2", "name": "林部长", "gender": "女", "quota": 2, "pin": "1111", "matched": []},
        {"id": "m3", "name": "赵部长", "gender": "男", "quota": 2, "pin": "1111", "matched": []},
        {"id": "m4", "name": "孙部长", "gender": "女", "quota": 2, "pin": "1111", "matched": []},
        {"id": "m5", "name": "周部长", "gender": "男", "quota": 2, "pin": "1111", "matched": []},
        {"id": "m6", "name": "吴部长", "gender": "女", "quota": 2, "pin": "1111", "matched": []},
        {"id": "m7", "name": "郑部长", "gender": "男", "quota": 2, "pin": "1111", "matched": []},
        {"id": "m8", "name": "王部长", "gender": "女", "quota": 2, "pin": "1111", "matched": []},
        {"id": "m9", "name": "冯部长", "gender": "男", "quota": 2, "pin": "1111", "matched": []},
        {"id": "m10", "name": "褚部长", "gender": "女", "quota": 2, "pin": "1111", "matched": []},
    ]
    mentees = [
        {"id": f"s{i}", "name": f"干事{i:02d}", "gender": "男" if i % 2 != 0 else "女", "pin": "2222", "matched_minister_id": None}
        for i in range(1, 21)
    ]
    return {
        "current_round": 1,
        "max_rounds": 5,
        "status": "selecting",
        "settings": dict(DEFAULT_SETTINGS),
        "ministers": ministers,
        "mentees": mentees,
        "submissions": {
            "mentees": {},
            "ministers": {}
        },
        "history": [],
        "last_settled_pairs": []
    }

def load_state() -> Dict[str, Any]:
    """读取已存储数据；若存在有效数据绝不覆盖重置"""
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if data.get("ministers") and len(data["ministers"]) > 0:
                    if "settings" not in data:
                        data["settings"] = {
                            "num_mentees": len(data.get("mentees", [])),
                            "num_ministers": len(data.get("ministers", [])),
                            "mentee_pick_count": 4,
                            "minister_pick_count": 3,
                            "mentee_has_priority": True,
                            "minister_has_priority": False,
                        }
                    return data
        except Exception as e:
            print(f"[警告] 读取 state.json 异常: {e}")
            pass
    state = get_default_state()
    save_state(state, is_backup=False)
    return state

def save_state(state: Dict[str, Any], is_backup: bool = False):
    """
    数据持久化核心：
    1. 采用临时文件 + os.replace 原子化写入，确保绝对不会因断电或异常产生空文件或破损文件；
    2. 支持自动时间戳历史版本归档，保存在 data/backups 目录下。
    """
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(BACKUP_DIR, exist_ok=True)
    
    # 原子写入主状态
    tmp_file = STATE_FILE + f".tmp_{os.getpid()}_{time.time_ns()}_{uuid.uuid4().hex[:6]}"
    with open(tmp_file, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_file, STATE_FILE)

    # 自动版本归档
    if is_backup:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_file = os.path.join(BACKUP_DIR, f"backup_{timestamp}.json")
        try:
            with open(backup_file, "w", encoding="utf-8") as f:
                json.dump(state, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"[警告] 备份归档失败: {e}")

STATE = load_state()

# WebSocket 连接池
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception:
                self.disconnect(connection)

manager = ConnectionManager()

async def broadcast_state(event_type: str = "state_update", extra_data: dict = None):
    payload = {
        "type": event_type,
        "state": get_sanitized_state(),
        "extra": extra_data or {}
    }
    await manager.broadcast(payload)

def get_sanitized_state() -> Dict[str, Any]:
    global STATE
    submitted_mentee_ids = list(STATE["submissions"]["mentees"].keys())
    submitted_minister_ids = list(STATE["submissions"]["ministers"].keys())
    
    ministers_info = []
    for m in STATE["ministers"]:
        ministers_info.append({
            "id": m["id"],
            "name": m["name"],
            "gender": m.get("gender", "未知"),
            "quota": m["quota"],
            "matched_count": len(m.get("matched", [])),
            "matched_mentee_ids": m.get("matched", []),
            "is_full": len(m.get("matched", [])) >= m["quota"]
        })
        
    mentees_info = []
    for s in STATE["mentees"]:
        mentees_info.append({
            "id": s["id"],
            "name": s["name"],
            "gender": s.get("gender", "未知"),
            "matched_minister_id": s["matched_minister_id"],
            "is_matched": s["matched_minister_id"] is not None
        })

    total_matched = sum(1 for s in mentees_info if s["is_matched"])

    return {
        "current_round": STATE["current_round"],
        "max_rounds": STATE["max_rounds"],
        "status": STATE["status"],
        "settings": STATE.get("settings", DEFAULT_SETTINGS),
        "ministers": ministers_info,
        "mentees": mentees_info,
        "total_matched": total_matched,
        "total_mentees": len(mentees_info),
        "submitted_mentee_ids": submitted_mentee_ids,
        "submitted_minister_ids": submitted_minister_ids,
        "history": STATE.get("history", []),
        "last_settled_pairs": STATE.get("last_settled_pairs", [])
    }

# --- Pydantic 模型 ---
class SettingsUpdateRequest(BaseModel):
    num_mentees: Optional[int] = None
    num_ministers: Optional[int] = None
    mentee_pick_count: int = 4
    minister_pick_count: int = 3
    mentee_has_priority: bool = True
    minister_has_priority: bool = False
    admin_pin: Optional[str] = None
    token: Optional[str] = None

class SimulationRequest(BaseModel):
    num_mentees: int = 20
    num_ministers: int = 10
    mentee_pick_count: int = 4
    minister_pick_count: int = 3
    mentee_has_priority: bool = True
    minister_has_priority: bool = False
    runs: Optional[int] = 20000
    admin_pin: Optional[str] = None
    token: Optional[str] = None

class LoginRequest(BaseModel):
    role: str
    id: Optional[str] = None
    pin: str

class MenteeSubmitRequest(BaseModel):
    mentee_id: str
    pin: Optional[str] = None
    token: Optional[str] = None
    choices: List[str]

class MinisterSubmitRequest(BaseModel):
    minister_id: str
    pin: Optional[str] = None
    token: Optional[str] = None
    choices: List[str]

class MemberUpdateRequest(BaseModel):
    admin_pin: Optional[str] = None
    token: Optional[str] = None
    ministers: List[Dict[str, Any]]
    mentees: List[Dict[str, Any]]

# --- 权限校验辅助函数 ---
def check_admin_auth(admin_pin: Optional[str] = None, authorization: Optional[str] = None, req_token: Optional[str] = None) -> bool:
    if admin_pin and str(admin_pin).strip() == ADMIN_PIN:
        return True
    tok = req_token
    if not tok and authorization:
        tok = authorization[7:] if authorization.startswith("Bearer ") else authorization
    if tok:
        sess = SESSIONS.get(tok.strip())
        if sess and sess.get("role") == "admin":
            return True
    return False

# --- API 路由 ---

@app.get("/api/state")
async def get_state():
    return get_sanitized_state()

@app.post("/api/auth/login")
async def login(req: LoginRequest):
    global STATE
    token = secrets.token_hex(24)

    if req.role == "admin":
        if req.pin == ADMIN_PIN:
            SESSIONS[token] = {"role": "admin", "id": "admin", "time": time.time()}
            save_sessions(SESSIONS)
            return {"status": "ok", "token": token, "role": "admin", "name": "系统管理员"}
        raise HTTPException(status_code=401, detail="管理员密码错误")

    elif req.role == "minister":
        target = next((m for m in STATE["ministers"] if m["id"] == req.id), None)
        if not target:
            raise HTTPException(status_code=404, detail="未找到该部长")
        if target.get("pin") and str(target["pin"]).strip() != str(req.pin).strip():
            raise HTTPException(status_code=401, detail="部长专属PIN码错误")
        SESSIONS[token] = {"role": "minister", "id": target["id"], "time": time.time()}
        save_sessions(SESSIONS)
        submitted_choices = STATE["submissions"]["ministers"].get(target["id"], [])
        return {
            "status": "ok",
            "token": token,
            "role": "minister",
            "id": target["id"],
            "name": target["name"],
            "gender": target.get("gender", "未知"),
            "quota": target["quota"],
            "matched": target.get("matched", []),
            "is_full": len(target.get("matched", [])) >= target["quota"],
            "submitted_choices": submitted_choices
        }

    elif req.role == "mentee":
        target = next((s for s in STATE["mentees"] if s["id"] == req.id), None)
        if not target:
            raise HTTPException(status_code=404, detail="未找到该干事")
        if target.get("pin") and str(target["pin"]).strip() != str(req.pin).strip():
            raise HTTPException(status_code=401, detail="干事专属PIN码错误")
        SESSIONS[token] = {"role": "mentee", "id": target["id"], "time": time.time()}
        save_sessions(SESSIONS)
        submitted_choices = STATE["submissions"]["mentees"].get(target["id"], [])
        return {
            "status": "ok",
            "token": token,
            "role": "mentee",
            "id": target["id"],
            "name": target["name"],
            "gender": target.get("gender", "未知"),
            "matched_minister_id": target["matched_minister_id"],
            "is_matched": target["matched_minister_id"] is not None,
            "submitted_choices": submitted_choices
        }
    
    raise HTTPException(status_code=400, detail="未知角色")

@app.get("/api/auth/me")
async def get_current_user(authorization: Optional[str] = Header(None)):
    """通过安全 Session Token 恢复登录态，无需前端保留明文 PIN 码"""
    if not authorization:
        raise HTTPException(status_code=401, detail="未提供身份凭证")
    token = authorization[7:] if authorization.startswith("Bearer ") else authorization
    session = SESSIONS.get(token.strip())
    if not session:
        raise HTTPException(status_code=401, detail="登录会话已失效，请重新登录")

    role = session.get("role")
    sid = session.get("id")

    if role == "admin":
        return {"status": "ok", "role": "admin", "name": "系统管理员"}
    elif role == "minister":
        target = next((m for m in STATE["ministers"] if m["id"] == sid), None)
        if not target:
            raise HTTPException(status_code=404, detail="未找到部长")
        submitted_choices = STATE["submissions"]["ministers"].get(target["id"], [])
        return {
            "status": "ok",
            "role": "minister",
            "id": target["id"],
            "name": target["name"],
            "gender": target.get("gender", "未知"),
            "quota": target["quota"],
            "matched": target.get("matched", []),
            "is_full": len(target.get("matched", [])) >= target["quota"],
            "submitted_choices": submitted_choices
        }
    elif role == "mentee":
        target = next((s for s in STATE["mentees"] if s["id"] == sid), None)
        if not target:
            raise HTTPException(status_code=404, detail="未找到干事")
        submitted_choices = STATE["submissions"]["mentees"].get(target["id"], [])
        return {
            "status": "ok",
            "role": "mentee",
            "id": target["id"],
            "name": target["name"],
            "gender": target.get("gender", "未知"),
            "matched_minister_id": target["matched_minister_id"],
            "is_matched": target["matched_minister_id"] is not None,
            "submitted_choices": submitted_choices
        }
    raise HTTPException(status_code=400, detail="未知角色")

@app.post("/api/mentee/submit")
async def mentee_submit(req: MenteeSubmitRequest):
    global STATE
    if STATE["status"] != "selecting":
        raise HTTPException(status_code=400, detail="当前轮次未开放选择或已结算")
    
    mentee = next((s for s in STATE["mentees"] if s["id"] == req.mentee_id), None)
    if not mentee:
        raise HTTPException(status_code=404, detail="未找到干事")

    # 优先校验 Session Token，兼容 PIN 码
    authed = False
    if req.token:
        sess = SESSIONS.get(req.token.strip())
        if sess and sess.get("role") == "mentee" and sess.get("id") == req.mentee_id:
            authed = True
    if not authed and req.pin:
        if mentee.get("pin") and str(mentee["pin"]).strip() == str(req.pin).strip():
            authed = True
    if not authed:
        raise HTTPException(status_code=401, detail="身份认证失败，请重新登录")

    if mentee["matched_minister_id"]:
        raise HTTPException(status_code=400, detail="您已经成功配对，无需再选")

    # 动态计算当前尚有名额的部长数量，支持至多挑选设定的顺位部长
    settings = STATE.get("settings", DEFAULT_SETTINGS)
    max_picks_setting = settings.get("mentee_pick_count", 4)
    available_ministers = [m for m in STATE["ministers"] if len(m.get("matched", [])) < m["quota"]]
    target_picks = min(max_picks_setting, len(available_ministers))

    if len(req.choices[:target_picks]) != len(set(req.choices[:target_picks])):
        raise HTTPException(status_code=400, detail="所选顺位部长存在重复，请为不同顺位选择不同的部长！")

    valid_choices = []
    for mid in req.choices[:target_picks]:
        minister = next((m for m in STATE["ministers"] if m["id"] == mid), None)
        if minister and len(minister.get("matched", [])) < minister["quota"]:
            valid_choices.append(mid)
    
    if len(valid_choices) < target_picks:
        raise HTTPException(status_code=400, detail=f"请选择 {target_picks} 位不同的、尚有名额的有效目标部长")

    STATE["submissions"]["mentees"][req.mentee_id] = valid_choices
    save_state(STATE)
    await broadcast_state("submission_update", {"submitter_role": "mentee", "id": req.mentee_id})
    return {"status": "ok", "message": f"提交成功！已收录您的 {len(valid_choices)} 个顺位目标部长", "choices": valid_choices}

@app.post("/api/minister/submit")
async def minister_submit(req: MinisterSubmitRequest):
    global STATE
    if STATE["status"] != "selecting":
        raise HTTPException(status_code=400, detail="当前轮次未开放选择或已结算")

    minister = next((m for m in STATE["ministers"] if m["id"] == req.minister_id), None)
    if not minister:
        raise HTTPException(status_code=404, detail="未找到部长")

    # 优先校验 Session Token，兼容 PIN 码
    authed = False
    if req.token:
        sess = SESSIONS.get(req.token.strip())
        if sess and sess.get("role") == "minister" and sess.get("id") == req.minister_id:
            authed = True
    if not authed and req.pin:
        if minister.get("pin") and str(minister["pin"]).strip() == str(req.pin).strip():
            authed = True
    if not authed:
        raise HTTPException(status_code=401, detail="身份认证失败，请重新登录")
    
    remain_quota = minister["quota"] - len(minister.get("matched", []))
    if remain_quota <= 0:
        raise HTTPException(status_code=400, detail="您的名额已全部配对满额，无需再选")

    # 待选干事上限校验：允许部长挑选至多设定数量的候选意向干事
    settings = STATE.get("settings", DEFAULT_SETTINGS)
    max_picks_setting = settings.get("minister_pick_count", 3)
    unmatched_mentees = [s for s in STATE["mentees"] if s["matched_minister_id"] is None]
    max_picks = min(max_picks_setting, len(unmatched_mentees))

    if len(req.choices[:max_picks]) != len(set(req.choices[:max_picks])):
        raise HTTPException(status_code=400, detail="所选干事中存在重复人员，请调整为不同的干事！")

    valid_choices = []
    for sid in req.choices[:max_picks]:
        mentee = next((s for s in STATE["mentees"] if s["id"] == sid), None)
        if mentee and mentee["matched_minister_id"] is None:
            valid_choices.append(sid)

    if len(valid_choices) < max_picks:
        raise HTTPException(status_code=400, detail=f"请选择 {max_picks} 位不同的待选干事")

    STATE["submissions"]["ministers"][req.minister_id] = valid_choices
    save_state(STATE)
    await broadcast_state("submission_update", {"submitter_role": "minister", "id": req.minister_id})
    return {"status": "ok", "message": f"提交成功！已收录您的 {len(valid_choices)} 位候选意向干事", "choices": valid_choices}

@app.post("/api/admin/mock-submissions")
async def admin_mock_submissions(
    admin_pin: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    token: Optional[str] = Query(None)
):
    global STATE
    if not check_admin_auth(admin_pin=admin_pin, authorization=authorization, req_token=token):
        raise HTTPException(status_code=401, detail="无管理员权限")

    if STATE["status"] != "selecting":
        raise HTTPException(status_code=400, detail="当前并非在选择阶段，无法使用调试模式模拟提交")

    available_ministers = [m for m in STATE["ministers"] if len(m.get("matched", [])) < m["quota"]]
    unmatched_mentees = [s for s in STATE["mentees"] if s["matched_minister_id"] is None]

    if not available_ministers:
        raise HTTPException(status_code=400, detail="所有部长名额均已满，无需再提交")

    if not unmatched_mentees:
        raise HTTPException(status_code=400, detail="所有干事均已完成配对，无需再提交")

    settings = STATE.get("settings", DEFAULT_SETTINGS)
    mentee_limit = settings.get("mentee_pick_count", 4)
    minister_limit = settings.get("minister_pick_count", 3)

    # 构建全体待提交人员队列并随机打乱，模拟每个人不同的真实提交时间
    participants = []
    for s in unmatched_mentees:
        participants.append(("mentee", s))
    for m in available_ministers:
        participants.append(("minister", m))

    random.shuffle(participants)

    mentees_count = 0
    ministers_count = 0
    total = len(participants)
    base_delay = 2.5 / max(1, total)

    for role, person in participants:
        delay = random.uniform(base_delay * 0.4, base_delay * 1.6)
        await asyncio.sleep(delay)

        if role == "mentee":
            num_choices = min(mentee_limit, len(available_ministers))
            if num_choices > 0:
                picks = random.sample([m["id"] for m in available_ministers], num_choices)
                STATE["submissions"]["mentees"][person["id"]] = picks
                mentees_count += 1
                await broadcast_state("submission_update", {"submitter_role": "mentee", "id": person["id"]})
        else:
            max_picks = min(minister_limit, len(unmatched_mentees))
            if max_picks > 0:
                picks = random.sample([s["id"] for s in unmatched_mentees], max_picks)
                STATE["submissions"]["ministers"][person["id"]] = picks
                ministers_count += 1
                await broadcast_state("submission_update", {"submitter_role": "minister", "id": person["id"]})

    save_state(STATE)
    await broadcast_state("batch_submission_update", {"mentees_count": mentees_count, "ministers_count": ministers_count})

    return {
        "status": "ok",
        "message": "调试模式生效中，请点击结算本轮来完成匹配",
        "mentees_count": mentees_count,
        "ministers_count": ministers_count,
        "state": get_sanitized_state()
    }

@app.post("/api/admin/settle-round")
async def admin_settle_round(
    admin_pin: Optional[str] = Header(None), 
    authorization: Optional[str] = Header(None),
    force: Optional[bool] = Query(False)
):
    global STATE
    if not check_admin_auth(admin_pin=admin_pin, authorization=authorization):
        raise HTTPException(status_code=401, detail="无管理员权限")
    
    if STATE["status"] != "selecting":
        raise HTTPException(status_code=400, detail="当前并非在选择阶段")

    mentee_subs = STATE["submissions"]["mentees"]
    minister_subs = STATE["submissions"]["ministers"]

    # 校验是否所有待配对干事和未满额部长均已提交
    unmatched_mentees = [s for s in STATE["mentees"] if s["matched_minister_id"] is None]
    unfilled_ministers = [m for m in STATE["ministers"] if len(m.get("matched", [])) < m["quota"]]

    missing_mentees = [s for s in unmatched_mentees if s["id"] not in mentee_subs]
    missing_ministers = [m for m in unfilled_ministers if m["id"] not in minister_subs]

    if (missing_mentees or missing_ministers) and not force:
        err_msg_parts = []
        if missing_mentees:
            names = [s["name"] for s in missing_mentees]
            sample = "、".join(names[:3]) + (f" 等共{len(names)}人" if len(names) > 3 else "")
            err_msg_parts.append(f"干事未提交（{sample}）")
        if missing_ministers:
            names = [m["name"] for m in missing_ministers]
            sample = "、".join(names[:3]) + (f" 等共{len(names)}人" if len(names) > 3 else "")
            err_msg_parts.append(f"部长未提交（{sample}）")
        raise HTTPException(status_code=400, detail=f"尚未全员提交，无法开始匹配！需等待：{'；'.join(err_msg_parts)}")

    # --- 升级版确定性两阶段撮合引擎（支持部长4人平权意向池 + 全局福利最大化仲裁） ---
    # 规则说明：
    # 1. 部长选4人完全平权：无主次先后之分，只要候选人在集合内即视为平权认可；
    # 2. 干事有明确顺位优先：第 1 意向具有绝对优先级（阶段一优先清算）；
    # 3. 超额平权冲突仲裁（Tie-Breaker）：当多名同顺位干事竞争同个部长的剩余名额时，
    #    优先保护第二志愿无有效出路的干事（防止其落单），把名额让渡给最需要的人，消除网络手速/字典序偏见；
    # 4. 阶段二清算：第一阶段未结对的干事，按其第 2 意向与尚有名额且认可该干事的部长撮合。

    newly_matched = []
    settings = STATE.get("settings", DEFAULT_SETTINGS)
    mentee_pick_count = settings.get("mentee_pick_count", 4)
    mentee_has_priority = settings.get("mentee_has_priority", True)
    minister_has_priority = settings.get("minister_has_priority", False)

    minister_order_map = {
        mid: list(choices) for mid, choices in minister_subs.items()
    }
    minister_pick_sets = {
        mid: set(choices) for mid, choices in minister_subs.items()
    }

    if mentee_has_priority:
        # 干事开启顺位优先：逐级按顺位撮合 (第 1 顺位 -> 第 2 顺位 ...)
        for rank in range(1, mentee_pick_count + 1):
            rank_idx = rank - 1
            p_candidates = {m["id"]: [] for m in STATE["ministers"] if len(m.get("matched", [])) < m["quota"]}
            for sid, m_choices in mentee_subs.items():
                mentee_obj = next((s for s in STATE["mentees"] if s["id"] == sid), None)
                if mentee_obj and mentee_obj["matched_minister_id"] is None:
                    if len(m_choices) > rank_idx:
                        mid = m_choices[rank_idx]
                        if mid in p_candidates and sid in minister_pick_sets.get(mid, set()):
                            p_candidates[mid].append(sid)

            for mid, cands in p_candidates.items():
                minister = next((m for m in STATE["ministers"] if m["id"] == mid), None)
                if not minister:
                    continue
                rem_quota = minister["quota"] - len(minister.get("matched", []))
                if rem_quota <= 0:
                    continue

                if len(cands) <= rem_quota:
                    chosen = cands
                else:
                    if minister_has_priority:
                        # 部长也开启顺位优先：按部长自己的候选名单顺序排序择优
                        m_order = minister_order_map.get(mid, [])
                        cands_pool = sorted(cands, key=lambda s: m_order.index(s) if s in m_order else 999)
                        chosen = cands_pool[:rem_quota]
                    else:
                        # 部长等权：完全公平抽签
                        cands_pool = list(cands)
                        random.shuffle(cands_pool)
                        chosen = cands_pool[:rem_quota]

                for sid in chosen:
                    mentee = next((s for s in STATE["mentees"] if s["id"] == sid), None)
                    if mentee and mentee["matched_minister_id"] is None and len(minister.get("matched", [])) < minister["quota"]:
                        mentee["matched_minister_id"] = mid
                        minister.setdefault("matched", []).append(sid)
                        newly_matched.append({
                            "mentee_id": sid,
                            "mentee_name": mentee["name"],
                            "mentee_gender": mentee.get("gender", "未知"),
                            "minister_id": mid,
                            "minister_name": minister["name"],
                            "minister_gender": minister.get("gender", "未知"),
                            "round": STATE["current_round"],
                            "preference_rank": rank,
                            "type": "mutual"
                        })
    else:
        # 干事等权池：干事申报的所有意向同时进入候选池
        p_candidates = {m["id"]: [] for m in STATE["ministers"] if len(m.get("matched", [])) < m["quota"]}
        for sid, m_choices in mentee_subs.items():
            mentee_obj = next((s for s in STATE["mentees"] if s["id"] == sid), None)
            if mentee_obj and mentee_obj["matched_minister_id"] is None:
                for mid in m_choices:
                    if mid in p_candidates and sid in minister_pick_sets.get(mid, set()):
                        p_candidates[mid].append(sid)

        for mid, cands in p_candidates.items():
            minister = next((m for m in STATE["ministers"] if m["id"] == mid), None)
            if not minister:
                continue
            rem_quota = minister["quota"] - len(minister.get("matched", []))
            if rem_quota <= 0:
                continue

            if len(cands) <= rem_quota:
                chosen = cands
            else:
                if minister_has_priority:
                    m_order = minister_order_map.get(mid, [])
                    cands_pool = sorted(cands, key=lambda s: m_order.index(s) if s in m_order else 999)
                    chosen = cands_pool[:rem_quota]
                else:
                    cands_pool = list(cands)
                    random.shuffle(cands_pool)
                    chosen = cands_pool[:rem_quota]

            for sid in chosen:
                mentee = next((s for s in STATE["mentees"] if s["id"] == sid), None)
                if mentee and mentee["matched_minister_id"] is None and len(minister.get("matched", [])) < minister["quota"]:
                    mentee["matched_minister_id"] = mid
                    minister.setdefault("matched", []).append(sid)
                    newly_matched.append({
                        "mentee_id": sid,
                        "mentee_name": mentee["name"],
                        "mentee_gender": mentee.get("gender", "未知"),
                        "minister_id": mid,
                        "minister_name": minister["name"],
                        "minister_gender": minister.get("gender", "未知"),
                        "round": STATE["current_round"],
                        "preference_rank": 1,
                        "type": "mutual"
                    })

    round_record = {
        "round": STATE["current_round"],
        "newly_matched": newly_matched
    }
    STATE["history"].append(round_record)
    STATE["last_settled_pairs"] = newly_matched

    all_matched = all(s["matched_minister_id"] is not None for s in STATE["mentees"])
    all_ministers_full = all(len(m.get("matched", [])) >= m["quota"] for m in STATE["ministers"])

    if all_matched or all_ministers_full:
        STATE["status"] = "finished"
    else:
        STATE["status"] = "settled"

    STATE["submissions"] = {"mentees": {}, "ministers": {}}
    save_state(STATE, is_backup=True)

    await broadcast_state("round_settled", {"newly_matched": newly_matched, "round": round_record["round"]})
    return {"status": "ok", "newly_matched": newly_matched, "state": get_sanitized_state()}

@app.post("/api/admin/start-next-round")
async def admin_start_next_round(admin_pin: Optional[str] = Header(None), authorization: Optional[str] = Header(None)):
    global STATE
    if not check_admin_auth(admin_pin=admin_pin, authorization=authorization):
        raise HTTPException(status_code=401, detail="无管理员权限")
    
    if STATE["status"] != "settled":
        raise HTTPException(status_code=400, detail="只能在已结算状态下开启下一轮")

    if STATE["current_round"] >= STATE["max_rounds"]:
        raise HTTPException(status_code=400, detail="已达到最大设定的第 5 轮，请直接执行调剂干事完成兜底")

    STATE["current_round"] += 1
    STATE["status"] = "selecting"
    STATE["last_settled_pairs"] = []
    STATE["submissions"] = {"mentees": {}, "ministers": {}}
    save_state(STATE, is_backup=True)

    await broadcast_state("round_started", {"round": STATE["current_round"]})
    return {"status": "ok", "round": STATE["current_round"]}

@app.post("/api/admin/auto-fallback")
async def admin_auto_fallback(admin_pin: Optional[str] = Header(None), authorization: Optional[str] = Header(None)):
    global STATE
    if not check_admin_auth(admin_pin=admin_pin, authorization=authorization):
        raise HTTPException(status_code=401, detail="无管理员权限")

    unmatched_mentees = [s for s in STATE["mentees"] if s["matched_minister_id"] is None]
    available_ministers = [m for m in STATE["ministers"] if len(m.get("matched", [])) < m["quota"]]

    fallback_pairs = []
    for mentee in unmatched_mentees:
        assigned = False
        for minister in available_ministers:
            if len(minister.get("matched", [])) < minister["quota"]:
                mentee["matched_minister_id"] = minister["id"]
                minister.setdefault("matched", []).append(mentee["id"])
                fallback_pairs.append({
                    "mentee_id": mentee["id"],
                    "mentee_name": mentee["name"],
                    "mentee_gender": mentee.get("gender", "未知"),
                    "minister_id": minister["id"],
                    "minister_name": minister["name"],
                    "minister_gender": minister.get("gender", "未知"),
                    "round": STATE["current_round"],
                    "type": "fallback"
                })
                assigned = True
                break
        if not assigned:
            break

    STATE["status"] = "finished"
    STATE["history"].append({
        "round": "调剂轮",
        "newly_matched": fallback_pairs
    })
    STATE["last_settled_pairs"] = fallback_pairs
    save_state(STATE, is_backup=True)

    await broadcast_state("fallback_completed", {"fallback_pairs": fallback_pairs})
    return {"status": "ok", "fallback_pairs": fallback_pairs, "state": get_sanitized_state()}

@app.post("/api/admin/reset")
async def admin_reset(admin_pin: Optional[str] = Header(None), authorization: Optional[str] = Header(None)):
    global STATE
    if not check_admin_auth(admin_pin=admin_pin, authorization=authorization):
        raise HTTPException(status_code=401, detail="无管理员权限")
    
    # 彻底重置配对与轮次，完整保留已自定义的干事与部长人员名单及PIN码
    for m in STATE["ministers"]:
        m["matched"] = []
    for s in STATE["mentees"]:
        s["matched_minister_id"] = None
    
    STATE["current_round"] = 1
    STATE["status"] = "selecting"
    STATE["submissions"] = {"mentees": {}, "ministers": {}}
    STATE["history"] = []
    STATE["last_settled_pairs"] = []
    save_state(STATE, is_backup=True)

    await broadcast_state("system_reset")
    return {"status": "ok", "message": "配对数据已重置为初始第1轮，人员名单与PIN码已完好保留"}

@app.get("/api/admin/all-data")
async def admin_get_all_data(admin_pin: Optional[str] = Header(None), authorization: Optional[str] = Header(None)):
    global STATE
    if not check_admin_auth(admin_pin=admin_pin, authorization=authorization):
        raise HTTPException(status_code=401, detail="无管理员权限")
    return STATE

@app.post("/api/admin/update-members")
async def admin_update_members(req: MemberUpdateRequest, authorization: Optional[str] = Header(None)):
    """
    修改人员名单与PIN码专属接口：
    具备智能合并机制（即使在活动中修改名单，也绝不冲掉已有的结对匹配记录），
    并自动触发本地时间戳版本备份！
    """
    global STATE
    if not check_admin_auth(admin_pin=req.admin_pin, authorization=authorization, req_token=req.token):
        raise HTTPException(status_code=401, detail="无管理员权限")

    # 智能保留已有配对关系的平滑合并
    old_ministers_map = {m["id"]: m for m in STATE.get("ministers", [])}
    new_ministers = []
    for m in req.ministers:
        old_m = old_ministers_map.get(m["id"], {})
        new_ministers.append({
            "id": m["id"],
            "name": str(m.get("name", old_m.get("name", ""))).strip(),
            "gender": str(m.get("gender", old_m.get("gender", "男"))).strip(),
            "quota": int(m.get("quota", old_m.get("quota", 2))),
            "pin": str(m.get("pin", old_m.get("pin", "1111"))).strip(),
            "matched": old_m.get("matched", [])  # 严格保全配对关系！
        })

    old_mentees_map = {s["id"]: s for s in STATE.get("mentees", [])}
    new_mentees = []
    for s in req.mentees:
        old_s = old_mentees_map.get(s["id"], {})
        new_mentees.append({
            "id": s["id"],
            "name": str(s.get("name", old_s.get("name", ""))).strip(),
            "gender": str(s.get("gender", old_s.get("gender", "男"))).strip(),
            "pin": str(s.get("pin", old_s.get("pin", "2222"))).strip(),
            "matched_minister_id": old_s.get("matched_minister_id", None)  # 严格保全！
        })

    STATE["ministers"] = new_ministers
    STATE["mentees"] = new_mentees

    # 触发原子保存与带时间戳的双重归档
    save_state(STATE, is_backup=True)

    await broadcast_state("members_updated")
    return {"status": "ok", "message": "人员信息与专属PIN码已安全持久化并创建历史归档！"}

@app.get("/api/admin/settings")
async def admin_get_settings(
    admin_pin: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    token: Optional[str] = Query(None)
):
    global STATE
    if not check_admin_auth(admin_pin=admin_pin, authorization=authorization, req_token=token):
        raise HTTPException(status_code=401, detail="无管理员权限")
    return {"status": "ok", "settings": STATE.get("settings", DEFAULT_SETTINGS)}

@app.post("/api/admin/settings")
async def admin_update_settings(
    req: SettingsUpdateRequest,
    admin_pin: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    token: Optional[str] = Query(None)
):
    global STATE
    eff_pin = req.admin_pin or admin_pin
    eff_token = req.token or token
    if not check_admin_auth(admin_pin=eff_pin, authorization=authorization, req_token=eff_token):
        raise HTTPException(status_code=401, detail="无管理员权限")

    mentee_picks = max(1, min(4, int(req.mentee_pick_count)))
    minister_picks = max(1, min(4, int(req.minister_pick_count)))
    
    current_settings = STATE.setdefault("settings", dict(DEFAULT_SETTINGS))
    current_settings["mentee_pick_count"] = mentee_picks
    current_settings["minister_pick_count"] = minister_picks
    current_settings["mentee_has_priority"] = bool(req.mentee_has_priority)
    current_settings["minister_has_priority"] = bool(req.minister_has_priority)
    if req.num_mentees is not None and req.num_mentees > 0:
        current_settings["num_mentees"] = int(req.num_mentees)
    if req.num_ministers is not None and req.num_ministers > 0:
        current_settings["num_ministers"] = int(req.num_ministers)

    save_state(STATE)
    await broadcast_state("settings_update", {"settings": current_settings})
    return {"status": "ok", "message": "规则设置已保存并全端实时同步", "settings": current_settings}

SIM_CACHE_FILE = os.path.join(DATA_DIR, "simulation_cache.json")
_SIM_CACHE_MEM = None
_SIM_CACHE_MTIME = 0

def get_from_simulation_cache(num_mentees: int, num_ministers: int, s_picks: int, m_picks: int, s_prio: bool, m_prio: bool) -> Optional[Dict[str, Any]]:
    global _SIM_CACHE_MEM, _SIM_CACHE_MTIME
    if os.path.exists(SIM_CACHE_FILE):
        try:
            mtime = os.path.getmtime(SIM_CACHE_FILE)
            if _SIM_CACHE_MEM is None or mtime > _SIM_CACHE_MTIME:
                with open(SIM_CACHE_FILE, "r", encoding="utf-8") as f:
                    _SIM_CACHE_MEM = json.load(f)
                _SIM_CACHE_MTIME = mtime

            k_full = f"{num_mentees}_{num_ministers}_{s_picks}_{m_picks}_{int(s_prio)}_{int(m_prio)}"
            k_short = f"{s_picks}_{m_picks}_{int(s_prio)}_{int(m_prio)}"

            if _SIM_CACHE_MEM and k_full in _SIM_CACHE_MEM:
                return dict(_SIM_CACHE_MEM[k_full])
            if _SIM_CACHE_MEM and k_short in _SIM_CACHE_MEM:
                return dict(_SIM_CACHE_MEM[k_short])
        except Exception as e:
            print(f"[CACHE] 读取模拟缓存失败: {e}")
    return None

@app.post("/api/admin/simulate")
async def admin_simulate(
    req: SimulationRequest,
    admin_pin: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    token: Optional[str] = Query(None)
):
    eff_pin = req.admin_pin or admin_pin
    eff_token = req.token or token
    if not check_admin_auth(admin_pin=eff_pin, authorization=authorization, req_token=eff_token):
        raise HTTPException(status_code=401, detail="无管理员权限")

    s_picks = max(1, min(5, req.mentee_pick_count))
    m_picks = max(1, min(5, req.minister_pick_count))
    s_prio = bool(req.mentee_has_priority)
    m_prio = bool(req.minister_has_priority)
    n_mentees = int(req.num_mentees or 20)
    n_ministers = int(req.num_ministers or 10)

    # 1. 优先查阅毫秒级预计算缓存
    cached = get_from_simulation_cache(n_mentees, n_ministers, s_picks, m_picks, s_prio, m_prio)
    if cached:
        return cached

    # 2. 缓存未命中时（如自定义了非常规人数），回退至多核动态模拟
    runs = min(50000, max(5000, req.runs or 20000))
    loop = asyncio.get_running_loop()
    res = await loop.run_in_executor(
        None,
        run_simulation,
        n_mentees,
        n_ministers,
        s_picks,
        m_picks,
        s_prio,
        m_prio,
        runs
    )
    return res

@app.get("/api/admin/backup-download")
async def admin_backup_download(admin_pin: Optional[str] = None, token: Optional[str] = None):
    """一键下载全量数据JSON备份到本地电脑"""
    global STATE
    if not check_admin_auth(admin_pin=admin_pin, req_token=token):
        raise HTTPException(status_code=401, detail="无权下载备份文件")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    json_bytes = json.dumps(STATE, ensure_ascii=False, indent=2).encode("utf-8")
    
    response = Response(content=json_bytes, media_type="application/json")
    response.headers["Content-Disposition"] = f"attachment; filename=mentor_matching_full_backup_{timestamp}.json"
    return response

@app.get("/api/admin/export-csv")
async def export_csv(admin_pin: Optional[str] = None, token: Optional[str] = None):
    global STATE
    if not check_admin_auth(admin_pin=admin_pin, req_token=token):
        raise HTTPException(status_code=401, detail="无权下载导出表格")

    output = io.StringIO()
    output.write("\ufeff")
    writer = csv.writer(output)
    
    writer.writerow(["部长编号", "部长姓名", "部长性别", "分配配额", "已配对干事1", "已配对干事2", "配对状态", "配对方式/轮次"])

    mentee_map = {s["id"]: f"{s['name']}({s.get('gender','-')})" for s in STATE["mentees"]}

    pair_round_info = {}
    for h in STATE.get("history", []):
        r_name = f"第{h['round']}轮" if isinstance(h['round'], int) else str(h['round'])
        for pair in h.get("newly_matched", []):
            pair_round_info[(pair["minister_id"], pair["mentee_id"])] = f"{r_name}({pair.get('type','mutual')})"

    for m in STATE["ministers"]:
        matched_mentee_names = [mentee_map.get(sid, sid) for sid in m.get("matched", [])]
        m1 = matched_mentee_names[0] if len(matched_mentee_names) > 0 else "【暂无】"
        m2 = matched_mentee_names[1] if len(matched_mentee_names) > 1 else "【暂无】"
        
        rounds = []
        for sid in m.get("matched", []):
            rounds.append(f"{mentee_map.get(sid, sid)}: {pair_round_info.get((m['id'], sid), '已配对')}")
        round_str = " | ".join(rounds) if rounds else "未配对"

        status_str = "已满额(2/2)" if len(m.get("matched", [])) >= m["quota"] else f"未满({len(m.get('matched', []))}/{m['quota']})"
        writer.writerow([m["id"], m["name"], m.get("gender", "未知"), m["quota"], m1, m2, status_str, round_str])

    unmatched_mentees = [f"{s['name']}({s.get('gender','-')})" for s in STATE["mentees"] if s["matched_minister_id"] is None]
    if unmatched_mentees:
        writer.writerow([])
        writer.writerow(["未分配干事名单:"] + unmatched_mentees)

    output.seek(0)
    response = StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv; charset=utf-8"
    )
    response.headers["Content-Disposition"] = "attachment; filename=mentor_mentee_pairing_result.csv"
    return response

# --- 前端静态文件热更新监听器 ---
async def watch_static_files():
    """监测 static 文件夹中 html/js/css 修改，一经保存立即向打开的浏览器广播热重载信号"""
    file_mtimes = {}
    while True:
        try:
            await asyncio.sleep(1.0)
            changed = False
            for root, _, files in os.walk(STATIC_DIR):
                for fname in files:
                    if fname.endswith((".html", ".js", ".css")):
                        fpath = os.path.join(root, fname)
                        mtime = os.path.getmtime(fpath)
                        if fpath in file_mtimes and mtime > file_mtimes[fpath]:
                            changed = True
                            print(f"[⚡热更新] 前端文件已修改: {fname}，触发全员浏览器自动热刷新！")
                        file_mtimes[fpath] = mtime
            if changed:
                await manager.broadcast({"type": "hot_reload"})
        except Exception:
            pass

@app.on_event("startup")
async def startup_event():
    pass

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        await websocket.send_json({
            "type": "state_update",
            "state": get_sanitized_state()
        })
        while True:
            await websocket.receive_text()
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        manager.disconnect(websocket)
@app.get("/favicon.ico", include_in_schema=False)
async def get_favicon():
    favicon_path = os.path.join(STATIC_DIR, "favicon.ico")
    if os.path.exists(favicon_path):
        return FileResponse(favicon_path)
    return Response(status_code=404)

if os.path.exists(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=False)
