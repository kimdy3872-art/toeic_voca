import os
import sys
import json
import webbrowser
import http.server
import socket
import socketserver
import subprocess
import threading
import time
from datetime import datetime, timedelta, timezone
import pandas as pd
from openpyxl import load_workbook
import sqlite3

# Add current folder to path to import parse_words
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from parse_words import parse_excel_files

# Store base and web directories
# Resolved from this file so moving the project does not break it. The vocabulary
# Excel and voca.db live one level up, beside the voca-practice folder.
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(BASE_DIR, "voca-practice", "web")
EXCEL_PATH = os.path.join(BASE_DIR, "토익 단어장.xlsx")
DB_PATH = os.path.join(BASE_DIR, "voca-practice", "voca.db")
DATA_JSON_PATH = os.path.join(WEB_DIR, "data.json")


def utc_now_iso():
    """Sync clock. Millisecond-precision UTC ISO-8601, byte-identical in shape to
    JavaScript's Date.toISOString() so the two sides can be compared as plain
    strings during last-write-wins merges."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def local_str_to_iso(value):
    """Convert a legacy local-time '%Y-%m-%d %H:%M:%S' stamp into the sync clock
    format. Used once, to backfill rows written before sync existed."""
    try:
        naive = datetime.strptime(str(value).strip(), "%Y-%m-%d %H:%M:%S")
        return naive.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    except (ValueError, TypeError):
        return None


# Spaced repetition. The interval shrinks as the miss count grows, so a word you
# keep getting wrong comes back sooner. Kept in step with store.js — both sides
# compute review dates locally and the merge only moves the resulting string.
WRONG_REVIEW_INTERVALS = {1: 3, 2: 2}   # wrong_count -> days until the next look
WRONG_REVIEW_MIN_DAYS = 1               # wrong_count 3 and up
CORRECT_REVIEW_DAYS = 7                 # a correct answer pushes the word out a week


def review_interval_days(wrong_count):
    """Days to wait before showing a just-missed word again."""
    try:
        count = int(wrong_count or 0)
    except (TypeError, ValueError):
        count = 0
    return WRONG_REVIEW_INTERVALS.get(count, WRONG_REVIEW_MIN_DAYS)


def today_local_str():
    """Local calendar date, 'YYYY-MM-DD'. Review dates are days, not instants:
    the user's 'today' is their wall clock, not UTC."""
    return datetime.now().strftime("%Y-%m-%d")


def add_days_str(date_str, days):
    """'YYYY-MM-DD' plus a day offset. Falls back to today for anything
    unparseable, which is also how a missing value is treated."""
    try:
        base = datetime.strptime(str(date_str).strip()[:10], "%Y-%m-%d")
    except (ValueError, TypeError, AttributeError):
        base = datetime.now()
    return (base + timedelta(days=days)).strftime("%Y-%m-%d")


def next_review_after_miss(wrong_count, from_date=None):
    return add_days_str(from_date or today_local_str(), review_interval_days(wrong_count))


def _column_names(cursor, table):
    cursor.execute(f"PRAGMA table_info({table})")
    return {row[1] for row in cursor.fetchall()}


def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS incorrect_words (
            english TEXT PRIMARY KEY,
            korean TEXT,
            category TEXT,
            wrong_count INTEGER DEFAULT 1,
            last_wrong_date TEXT
        )
    """)
    # Sync bookkeeping. `deleted` is a tombstone rather than a hard DELETE: without
    # it, a word the phone graduated offline would be resurrected by the next merge
    # with the Mac, which still has the row.
    existing_cols = _column_names(cursor, "incorrect_words")
    if "updated_at" not in existing_cols:
        cursor.execute("ALTER TABLE incorrect_words ADD COLUMN updated_at TEXT")
    if "deleted" not in existing_cols:
        cursor.execute("ALTER TABLE incorrect_words ADD COLUMN deleted INTEGER DEFAULT 0")
    cursor.execute("UPDATE incorrect_words SET deleted = 0 WHERE deleted IS NULL")
    cursor.execute("""
        SELECT english, last_wrong_date FROM incorrect_words
        WHERE updated_at IS NULL OR updated_at = ''
    """)
    for eng, last_wrong in cursor.fetchall():
        stamp = local_str_to_iso(last_wrong) or utc_now_iso()
        cursor.execute("UPDATE incorrect_words SET updated_at = ? WHERE english = ?", (stamp, eng))

    # Spaced-repetition bookkeeping. `next_review_date` is the day the word is due
    # again; `correct_streak` counts consecutive correct answers, because a word
    # only graduates to mastered_words after two in a row (one right answer on a
    # 4-choice question is a 25% guess).
    if "next_review_date" not in existing_cols:
        cursor.execute("ALTER TABLE incorrect_words ADD COLUMN next_review_date TEXT")
    if "correct_streak" not in existing_cols:
        cursor.execute("ALTER TABLE incorrect_words ADD COLUMN correct_streak INTEGER DEFAULT 0")
    cursor.execute("UPDATE incorrect_words SET correct_streak = 0 WHERE correct_streak IS NULL")
    # Backfill from the last miss, using the same interval rule as a live wrong
    # answer. Rows with no usable last_wrong_date fall back to today, i.e. due now.
    cursor.execute("""
        SELECT english, wrong_count, last_wrong_date FROM incorrect_words
        WHERE next_review_date IS NULL OR next_review_date = ''
    """)
    backfilled = cursor.fetchall()
    for eng, wrong_count, last_wrong in backfilled:
        due = next_review_after_miss(wrong_count, last_wrong or today_local_str())
        cursor.execute("UPDATE incorrect_words SET next_review_date = ? WHERE english = ?", (due, eng))
    if backfilled:
        print(f"Backfilled next_review_date for {len(backfilled)} incorrect words.")

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS mastered_words (
            english TEXT PRIMARY KEY,
            updated_at TEXT,
            deleted INTEGER DEFAULT 0
        )
    """)
    conn.commit()

    # Migrate existing data from Excel if SQLite is empty
    cursor.execute("SELECT COUNT(*) FROM incorrect_words")
    count = cursor.fetchone()[0]
    
    if count == 0 and os.path.exists(EXCEL_PATH):
        try:
            wb_sheets = []
            try:
                wb = load_workbook(EXCEL_PATH)
                wb_sheets = wb.sheetnames
                wb.close()
            except Exception as e_sheet:
                print(f"Error checking sheets for migration: {e_sheet}")
                
            if '오답노트' in wb_sheets:
                print("Found existing '오답노트' sheet in Excel. Migrating to SQLite DB...")
                df_inc = pd.read_excel(EXCEL_PATH, sheet_name='오답노트')
                migrated_count = 0
                for _, row in df_inc.iterrows():
                    eng = str(row.get("영어 단어", "")).strip()
                    kor = str(row.get("한국어 뜻", "")).strip()
                    cat = str(row.get("카테고리", "")).strip()
                    try:
                        wrong_cnt = int(row.get("틀린 횟수", 1))
                    except:
                        wrong_cnt = 1
                    last_date = str(row.get("최근 틀린 날짜", ""))
                    
                    if eng and kor and eng != "nan" and kor != "nan" and eng != "영어 단어":
                        cursor.execute("""
                            INSERT OR REPLACE INTO incorrect_words 
                            (english, korean, category, wrong_count, last_wrong_date)
                            VALUES (?, ?, ?, ?, ?)
                        """, (eng, kor, cat, wrong_cnt, last_date))
                        migrated_count += 1
                conn.commit()
                print(f"Successfully migrated {migrated_count} words from Excel '오답노트' sheet to SQLite DB.")
        except Exception as e_migration:
            print(f"Migration from Excel failed: {e_migration}")
            
    conn.close()


def record_incorrect_word(english, korean, category):
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = sqlite3.connect(DB_PATH)
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT wrong_count FROM incorrect_words WHERE english = ?", (english,))
        row = cursor.fetchone()
        if row:
            # Clearing the tombstone: a word answered correctly and later missed again
            # is live once more, and keeps its accumulated count. The miss also resets
            # the correct streak — "twice in a row" means in a row.
            new_count = (row[0] or 0) + 1
            cursor.execute("""
                UPDATE incorrect_words
                SET wrong_count = ?, last_wrong_date = ?, category = ?, korean = ?,
                    updated_at = ?, deleted = 0, next_review_date = ?, correct_streak = 0
                WHERE english = ?
            """, (new_count, now_str, category, korean, utc_now_iso(),
                  next_review_after_miss(new_count), english))
        else:
            cursor.execute("""
                INSERT INTO incorrect_words
                (english, korean, category, wrong_count, last_wrong_date, updated_at, deleted,
                 next_review_date, correct_streak)
                VALUES (?, ?, ?, 1, ?, ?, 0, ?, 0)
            """, (english, korean, category, now_str, utc_now_iso(),
                  next_review_after_miss(1)))
        conn.commit()
        print(f"Successfully recorded incorrect word '{english}' to SQLite DB.")
    finally:
        conn.close()


def remove_incorrect_word(english):
    conn = sqlite3.connect(DB_PATH)
    try:
        cursor = conn.cursor()
        cursor.execute("""
            UPDATE incorrect_words SET deleted = 1, updated_at = ? WHERE english = ?
        """, (utc_now_iso(), english))
        conn.commit()
        print(f"Successfully tombstoned '{english}' in SQLite DB (answered correctly).")
    finally:
        conn.close()


def export_to_excel():
    try:
        import pandas as pd
        conn = sqlite3.connect(DB_PATH)
        df_db = pd.read_sql_query("""
            SELECT english AS [영어 단어], 
                   korean AS [한국어 뜻], 
                   category AS [카테고리], 
                   wrong_count AS [틀린 횟수],
                   last_wrong_date AS [최근 틀린 날짜]
            FROM incorrect_words
            WHERE COALESCE(deleted, 0) = 0
        """, conn)
        conn.close()
        
        if df_db.empty:
            print("SQLite database has no incorrect words. Excel export skipped or will be empty.")
            df_db = pd.DataFrame(columns=["영어 단어", "한국어 뜻", "카테고리", "틀린 횟수", "최근 틀린 날짜"])

        # Write to Excel preserving other sheets
        if not os.path.exists(EXCEL_PATH):
            df_db.to_excel(EXCEL_PATH, sheet_name='오답노트', index=False)
        else:
            with pd.ExcelWriter(EXCEL_PATH, engine='openpyxl', mode='a', if_sheet_exists='replace') as writer:
                df_db.to_excel(writer, sheet_name='오답노트', index=False)
        print("Successfully exported SQLite database to Excel '오답노트' sheet.")
    except Exception as e:
        print(f"Failed to export SQLite database to Excel: {e}")
        raise e

def _read_sync_state(conn):
    cursor = conn.cursor()
    cursor.execute("""
        SELECT english, korean, category, wrong_count, last_wrong_date, updated_at, deleted,
               next_review_date, correct_streak
        FROM incorrect_words
    """)
    incorrect = [
        {
            "english": r[0],
            "korean": r[1] or "",
            "category": r[2] or "",
            "wrong_count": r[3] or 0,
            "last_wrong_date": r[4] or "",
            "updated_at": r[5] or "",
            "deleted": bool(r[6]),
            # A row that predates this column reads as due today, matching the
            # same fallback store.js applies to old localStorage records.
            "next_review_date": r[7] or today_local_str(),
            "correct_streak": r[8] or 0,
        }
        for r in cursor.fetchall()
    ]
    cursor.execute("SELECT english, updated_at, deleted FROM mastered_words")
    mastered = [
        {"english": r[0], "updated_at": r[1] or "", "deleted": bool(r[2])}
        for r in cursor.fetchall()
    ]
    return incorrect, mastered


def merge_sync_payload(incoming_incorrect, incoming_mastered):
    """Fold the phone's state into the Mac's, then hand the whole merged state back
    so the phone can replace its store wholesale.

    Per word, last-write-wins on `updated_at` decides the tombstone and the
    metadata. `wrong_count` takes the max instead, because it is a monotonic
    counter: plain LWW would silently drop misses accumulated on the losing side.
    """
    conn = sqlite3.connect(DB_PATH)
    try:
        cursor = conn.cursor()

        cursor.execute("""
            SELECT english, korean, category, wrong_count, last_wrong_date, updated_at, deleted,
                   next_review_date, correct_streak
            FROM incorrect_words
        """)
        local = {r[0]: r for r in cursor.fetchall()}

        for item in incoming_incorrect or []:
            eng = str(item.get("english", "")).strip()
            if not eng:
                continue
            remote_stamp = str(item.get("updated_at", "") or "")
            remote_count = int(item.get("wrong_count", 0) or 0)
            row = local.get(eng)
            if row is None:
                cursor.execute("""
                    INSERT INTO incorrect_words
                    (english, korean, category, wrong_count, last_wrong_date, updated_at, deleted,
                     next_review_date, correct_streak)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    eng,
                    str(item.get("korean", "") or ""),
                    str(item.get("category", "") or ""),
                    remote_count,
                    str(item.get("last_wrong_date", "") or ""),
                    remote_stamp or utc_now_iso(),
                    1 if item.get("deleted") else 0,
                    str(item.get("next_review_date", "") or "") or today_local_str(),
                    int(item.get("correct_streak", 0) or 0),
                ))
                continue

            local_stamp = str(row[5] or "")
            merged_count = max(remote_count, int(row[3] or 0))
            if remote_stamp > local_stamp:
                # `next_review_date` and `correct_streak` ride along with the LWW
                # metadata rather than taking a max: unlike wrong_count they are not
                # monotonic (a right answer pushes the date out, a wrong one resets
                # the streak), so the newer write is simply the truthful one. The
                # `or row[...]` fallbacks keep a client that predates these fields
                # from blanking them when it wins the timestamp comparison.
                cursor.execute("""
                    UPDATE incorrect_words
                    SET korean = ?, category = ?, wrong_count = ?, last_wrong_date = ?,
                        updated_at = ?, deleted = ?, next_review_date = ?, correct_streak = ?
                    WHERE english = ?
                """, (
                    str(item.get("korean", "") or row[1] or ""),
                    str(item.get("category", "") or row[2] or ""),
                    merged_count,
                    str(item.get("last_wrong_date", "") or row[4] or ""),
                    remote_stamp,
                    1 if item.get("deleted") else 0,
                    str(item.get("next_review_date", "") or "") or row[7] or today_local_str(),
                    int(item.get("correct_streak", row[8] or 0) or 0),
                    eng,
                ))
            elif merged_count != int(row[3] or 0):
                cursor.execute(
                    "UPDATE incorrect_words SET wrong_count = ? WHERE english = ?",
                    (merged_count, eng),
                )

        cursor.execute("SELECT english, updated_at FROM mastered_words")
        local_mastered = {r[0]: str(r[1] or "") for r in cursor.fetchall()}

        for item in incoming_mastered or []:
            eng = str(item.get("english", "")).strip()
            if not eng:
                continue
            remote_stamp = str(item.get("updated_at", "") or "")
            deleted = 1 if item.get("deleted") else 0
            if eng not in local_mastered:
                cursor.execute(
                    "INSERT INTO mastered_words (english, updated_at, deleted) VALUES (?, ?, ?)",
                    (eng, remote_stamp or utc_now_iso(), deleted),
                )
            elif remote_stamp > local_mastered[eng]:
                cursor.execute(
                    "UPDATE mastered_words SET updated_at = ?, deleted = ? WHERE english = ?",
                    (remote_stamp, deleted, eng),
                )

        conn.commit()
        return _read_sync_state(conn)
    finally:
        conn.close()


def build_sync_response(incoming_incorrect=None, incoming_mastered=None):
    """Full state for the phone: vocabulary from the Excel-derived data.json, plus
    the live incorrect/mastered tables. `오답노트` is stripped from the word map —
    data.json's copy is a stale snapshot, and the DB is the authority."""
    if incoming_incorrect is None and incoming_mastered is None:
        conn = sqlite3.connect(DB_PATH)
        try:
            incorrect, mastered = _read_sync_state(conn)
        finally:
            conn.close()
    else:
        incorrect, mastered = merge_sync_payload(incoming_incorrect, incoming_mastered)

    words = {}
    try:
        with open(DATA_JSON_PATH, "r", encoding="utf-8") as f:
            words = {k: v for k, v in json.load(f).items() if k != "오답노트"}
    except Exception as e:
        print(f"Failed to read data.json for sync: {e}")

    return {
        "status": "success",
        "server_time": utc_now_iso(),
        "words": words,
        "incorrect": incorrect,
        "mastered": mastered,
    }


class VocaHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def end_headers(self):
        # Local dev server: disable browser caching so edits to app.js / style.css / data.json
        # always show up on refresh instead of silently serving a stale copy.
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        # The iOS app's WebView runs on the capacitor://localhost origin, so every
        # response it touches — GETs included — is cross-origin and needs this.
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self):
        length = int(self.headers.get('Content-Length') or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode('utf-8'))

    def do_GET(self):
        if self.path.split('?')[0] == '/api/sync':
            try:
                self.send_json(200, build_sync_response())
            except Exception as e:
                print(f"Sync pull failed: {e}")
                self.send_json(500, {"status": "error", "message": str(e)})
            return
        super().do_GET()

    def do_POST(self):
        if self.path.split('?')[0] == '/api/sync':
            try:
                data = self.read_json_body()
                self.send_json(200, build_sync_response(
                    data.get('incorrect') or [],
                    data.get('mastered') or [],
                ))
            except Exception as e:
                print(f"Sync push failed: {e}")
                self.send_json(500, {"status": "error", "message": str(e)})
        elif self.path == '/api/incorrect':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            
            try:
                data = json.loads(post_data.decode('utf-8'))
                english = data.get('english', '').strip()
                korean = data.get('korean', '').strip()
                category = data.get('category', '').strip()
                
                if not english or not korean:
                    raise ValueError("English and Korean terms are required")
                
                # Update the SQLite DB
                self.record_incorrect_word(english, korean, category)
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success", "message": f"Recorded '{english}'"}).encode('utf-8'))
                
            except Exception as e:
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode('utf-8'))
        elif self.path == '/api/incorrect/remove':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)

            try:
                data = json.loads(post_data.decode('utf-8'))
                english = data.get('english', '').strip()

                if not english:
                    raise ValueError("English term is required")

                # Remove the word from the SQLite DB (graduated from incorrect list)
                self.remove_incorrect_word(english)

                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success", "message": f"Removed '{english}'"}).encode('utf-8'))

            except Exception as e:
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode('utf-8'))
        elif self.path == '/api/export':
            try:
                export_to_excel()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success", "message": "Successfully exported incorrect notes to Excel"}).encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        # Handle CORS preflight requests
        self.send_response(200)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def record_incorrect_word(self, english, korean, category):
        record_incorrect_word(english, korean, category)

    def remove_incorrect_word(self, english):
        remove_incorrect_word(english)

class DualStackTCPServer(socketserver.TCPServer):
    """Listens on IPv4 and IPv6 at once.

    An iPhone Personal Hotspot riding an IPv6-only carrier hands out no IPv4
    lease at all — the Mac's 192.0.0.2/32 is a synthetic CLAT address the phone
    cannot route to. Binding IPv4-only (socketserver's default) makes the server
    invisible to the phone on exactly the network we fall back to when the
    office Wi-Fi blocks device-to-device traffic. Binding :: with V6ONLY off
    keeps plain IPv4 LANs working through the v4-mapped path.
    """
    address_family = socket.AF_INET6
    allow_reuse_address = True

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


def _local_hostname():
    """The Bonjour name the phone can use, e.g. 'dykimMacBook-Pro.local'."""
    try:
        name = subprocess.run(["scutil", "--get", "LocalHostName"],
                              capture_output=True, text=True, timeout=5).stdout.strip()
        return f"{name}.local" if name else None
    except Exception:
        return None


def _local_addresses():
    """Addresses on this Mac that another device on the same network can reach.

    Returns (ipv4, ipv6). Three kinds of address are filtered out because
    printing them would send you chasing a dead end:
      - 127.x loopback and 169.254.x self-assigned: no other device can reach them
      - 192.0.0.x: the synthetic CLAT address macOS invents on IPv6-only
        networks. It looks like a normal LAN address and is not routable.
      - IPv6 'temporary' privacy addresses: valid right now, rotated within
        hours, so useless to save in the app's settings.
    """
    try:
        out = subprocess.run(["ifconfig"], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return [], []

    v4, v6 = [], []
    for line in out.splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "inet" and len(parts) > 1:
            addr = parts[1]
            if addr.startswith(("127.", "169.254.", "192.0.0.")):
                continue
            v4.append(addr)
        elif parts[0] == "inet6" and len(parts) > 1:
            if "temporary" in line or "clat46" in line:
                continue
            addr = parts[1].split("%")[0]
            try:
                first = int(addr.split(":")[0] or "0", 16)
            except ValueError:
                continue
            if 0x2000 <= first <= 0x3FFF:  # global unicast only, skips fe80 link-local
                v6.append(addr)
    return v4, v6


def print_reachable_urls(port):
    v4, v6 = _local_addresses()
    host = _local_hostname()

    print(f"\n  이 Mac:  http://localhost:{port}")
    print("  폰에서 쓸 주소 (앱 설정 > Mac 서버 주소):")
    if host:
        print(f"    http://{host}:{port}   <- 집 와이파이면 보통 이것만으로 됩니다")
    for addr in v4:
        print(f"    http://{addr}:{port}")
    for addr in v6:
        print(f"    http://[{addr}]:{port}")

    if not v4 and not v6:
        print("    (쓸 수 있는 주소가 없습니다 — Wi-Fi 연결을 확인하세요)")
    elif not v4:
        print("    * IPv4 주소가 없습니다. IPv6 전용 망(셀룰러 핫스팟 등)이므로")
        print("      대괄호까지 포함한 위 주소를 그대로 입력하세요.")
        print("      핫스팟을 껐다 켜면 이 주소는 바뀝니다.")
    print("    * 주소는 맞는데 폰에서 안 열리면, 그 망이 기기 간 통신을")
    print("      막는 것입니다 (회사·학교 Wi-Fi에서 흔함).")
    print()


def start_server(port=8080):
    handler = VocaHTTPRequestHandler

    with DualStackTCPServer(("", port), handler) as httpd:
        print_reachable_urls(port)

        # Launch browser in a background thread
        def open_browser():
            time.sleep(1.5)
            print("Opening browser...")
            webbrowser.open(f"http://localhost:{port}")
            
        threading.Thread(target=open_browser, daemon=True).start()
        
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")
            httpd.shutdown()

if __name__ == "__main__":
    # Initialize SQLite Database & Migrate existing data if needed
    init_db()
    
    # 1. Parse Excel data first
    print("Rebuilding vocabulary JSON database from Excel...")
    parse_excel_files()
    
    # 2. Start local server
    start_server()
