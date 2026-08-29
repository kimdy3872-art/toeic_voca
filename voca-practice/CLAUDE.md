# TOEIC 단어장 (Voca Trainer)

엑셀 단어장을 읽어 퀴즈/암기 학습을 제공하는 로컬 웹 앱. Capacitor로 감싼
iOS 앱이 같은 `web/` 소스를 공유하고, Wi-Fi 로컬 네트워크로 Mac과 동기화한다.

## 구조

```
web/            앱 UI (Mac 브라우저 = iOS WebView, 단일 소스)
  index.html    화면 마크업 + 설정 모달
  app.js        화면 로직
  store.js      localStorage 저장소 + 동기화 클라이언트
  style.css
  data.json     parse_words.py 가 엑셀에서 생성 (직접 수정 금지)
run.py          로컬 HTTP 서버 + /api/sync
parse_words.py  ../토익 단어장.xlsx → web/data.json
voca.db         오답노트 · 완료 단어 (Mac 쪽 원본)
ios/App/        Capacitor가 만든 Xcode 프로젝트 (SPM, CocoaPods 아님)
resign-ios.sh   무료 프로비저닝 주간 재서명
```

자세한 iOS 운영 절차는 `README-ios.md`.

## 명령

```bash
toeic                        # 아래 run.py 의 zsh 별칭 (~/.zshrc). 어디서든 실행 가능
python3 run.py               # 엑셀 재파싱 + 서버 (http://localhost:8080)
npx cap copy ios             # web/ → ios/App/App/public/
./resign-ios.sh <device-id>  # 빌드 + 서명 + 실기기 설치 (7일마다)
```

무선 연결된 폰은 인자 없이 실행하면 못 찾는다 — 아래 `devicectl` 항목 참고.

## 데이터 모델

- **단어 데이터**: Mac이 원본. 엑셀 → `data.json` → 폰. **단방향**
- **오답노트 · 완료 단어**: 양방향. 폰은 오프라인으로 완전 동작하고
  동기화할 때만 서버가 개입한다
- 병합은 `updated_at` 기준 last-write-wins. 단 `wrong_count`는 `max()`
- iOS 저장 키: `voca_incorrect_v2`, `voca_mastered_v2`, `voca_words_v2`,
  `voca_server_url`, `voca_last_sync`
- `incorrect_words` 행에는 `next_review_date`(YYYY-MM-DD) 와 `correct_streak` 가
  붙는다. 둘 다 `updated_at` LWW 를 따른다 — 단조 증가가 아니라서 max() 를
  쓰면 안 된다 (정답이 날짜를 밀고, 오답이 연속 횟수를 0으로 되돌린다)

### 엑셀을 고쳤을 때 폰에 반영하는 법

**재빌드가 필요 없다.** 단어 데이터도 동기화 응답에 실려 간다
(`run.py:337` 이 `data.json`을 읽어 넣고, `store.js:186` 이 받아서 저장한다).
앱에 번들된 `data.json`은 첫 실행용 씨앗일 뿐이고, 그 뒤로는 동기화로 받은
사본이 항상 이긴다 (`app.js:146`).

```
엑셀 수정 → toeic 재시작 → 폰에서 동기화 버튼
```

**`toeic`을 반드시 재시작해야 한다.** 엑셀 재파싱은 `run.py`의 `__main__`
블록에서 한 번만 돈다. 이미 떠 있는 서버는 엑셀 변경을 영원히 모른다.
반대로 `data.json`은 동기화 요청마다 새로 읽으므로, 한 번 재시작한 뒤에는
폰에서 몇 번을 동기화하든 최신이다.

재빌드(`resign-ios.sh`)가 필요한 건 `web/` 코드를 고쳤을 때와 7일 만료뿐이다.

## 퀴즈 선지 생성 (`buildChoiceOptions`)

선지는 단어의 **뜻 전체**를 보여준다. 예전에는 여러 뜻 중 하나만 무작위로
골라 보여줬는데, 그러면 학습자가 나머지 뜻을 영영 못 본다.

이 결정이 나머지 규칙을 전부 좌우한다.

- **모호함의 기준이 바뀐다.** 뜻을 다 보여주므로 오답이 두 번째 정답이 되는
  건 **뜻 집합이 완전히 같을 때뿐**이다. 전체 어휘에 그런 쌍이 3개밖에 없다
  (`exactly/precisely`, `commentary/description`, `advance/advancement`).
  후보가 남아돌아서 예전에 있던 "배제했다가 되살리는" fallback이 필요 없다.

- **뜻이 일부만 겹치는 오답은 배제 대상이 아니라 최우선 대상이다.**
  `examine "조사하다, 검토하다"` 옆에 `explore "조사하다, 탐험하다"` 를 놓으면
  정답은 여전히 하나인데 뜻 프로필 전체를 알아야 풀린다. 가장 좋은 오답이다.
  **버그로 보고 되돌리지 말 것** — 가중치를 6으로 준 이유가 있다. 4로 낮추면
  길이 매칭 항목들과 동점이 나면서 발현율이 13% → 11% 로 떨어진다.

- **길이가 정답을 알려준다.** 뜻 개수가 1~6개로 흩어져 있어서, 뜻 3개짜리
  선지 하나가 1개짜리들 사이에 있으면 그냥 보인다. 뜻 개수와 글자 수를
  둘 다 근접도로 점수에 넣는다. 이걸 빼면 난이도가 아니라 눈썰미 문제가 된다.

- **겹치는 오답은 1개, 파생어 오답은 2개로 제한한다.** 4개 중 3개가
  "조사하다"를 달고 있으면 뜻을 아는지가 아니라 사전 표제어를 외웠는지
  묻는 문제가 된다. 겹침 상한이 1인데도 근접 오답이 붙는 문제 비율은
  2일 때와 같은 14% 다 — 상한을 올려도 난이도는 안 오르고 저 경우만 는다.
  파생어는 다르다. `apply/applicant/application` 은 Part 5 가 실제로 묻는
  것이고, 오답 3개 중 2개여도 나머지 하나가 남으므로 그대로 둔다.

- 한→영 방향은 **문제 지문도 뜻 전체**여야 한다. 한 뜻만 내면 동의어가
  전부 정답이 되어 문제가 성립하지 않는다.

바꿀 일이 있으면 전체 어휘로 시뮬레이션을 돌려 확인할 것. 확인해야 할 불변식은
두 번째 정답 0건, 선지 부족 0건, 같은 단어 중복 0건, 정답 누락 0건이다.

## 단어 따라쓰기 (`updateTracingUI` 외)

화면에 보이는 글자는 전부 `#tracing-slots` 안의 슬롯이다. 그 위에 겹쳐 놓은
`#tracing-input`은 **완전히 투명**하고, 캐럿을 소유해서 폰 키보드를 띄우는
역할만 한다. 한 글자마다 슬롯 하나이므로 유령 글자와 입력한 글자가 정확히
같은 자리에 겹친다 — 입력창 하나에 텍스트를 넣는 방식으로는 가운데 정렬된
글자가 유령 글자 위에 절대 안 얹힌다.

- **캐럿은 항상 값의 끝에 고정한다** (`snapTracingCaret`). 중간에 커서를 옮길
  수 있으면 슬롯 `i`와 `value[i]`가 어긋나서 채점이 전부 밀린다. 투명한
  입력창이라 사용자는 커서 위치를 볼 수도 없다. 그래서 ←/→ 는 커서 이동이
  아니라 **이전/다음 단어**다.

- **공백 슬롯은 앞 단어 그룹 안에 넣는다.** 밖에 두면 flex 줄바꿈에서 공백이
  *다음 줄의 첫 항목*이 되어 줄 앞머리를 한 칸 잡아먹고, 줄 수가 예상보다
  늘어난다.

- **글자 크기는 줄 수 예산으로 정한다** (`TRACING_MAX_ROWS = 2`). 예전에는 한
  줄에 안 들어가면 "가장 긴 단어에 맞춘다"로 넘어갔는데, 그러면 폰에서
  `be eligible for benefits`가 40px로 **5줄 285px** 짜리 탑이 됐다. 지금은
  최대 크기부터 1px씩 낮추며 2줄 안에 들어가는 첫 크기를 쓴다.

- `TRACING_CHAR_EM` · `TRACING_SPACE_EM` 은 `style.css` 의 `.tracing-slot` ·
  `.tracing-space` 폭과 **같은 값이어야 한다**. 크기 계산이 이 값으로 줄 수를
  예측하므로, 한쪽만 고치면 카드 밖으로 삐져나가거나 쓸데없이 작아진다.
  전체 어휘 848개를 폭 295px 에서 돌려 2줄·넘침 0을 확인했다.

- **글자 비교는 접어서 한다** (`tracingFoldChar`). 대소문자, 악센트,
  둥근 따옴표를 같은 글자로 본다. `attach a résumé` 의 `é`는 어느 키보드에서도
  치기 번거롭고, `do one's utmost` 의 `'`는 **iOS가 자동으로 `'`로 바꾼다** —
  접지 않으면 폰에서 이 단어는 영원히 못 맞힌다. 유령 글자는 원래 철자를
  보여주므로 학습에는 손해가 없다.

- 철자 힌트 on/off 는 `voca_tracing_hints` 키로 **`Store` 밖의 localStorage**에
  직접 저장한다. 이 기기에서 힌트를 켜 두는지는 학습 기록이 아니라서 동기화
  페이로드에 낄 이유가 없다.

- 폰에서는 **화면에 들어왔다고 키보드를 띄우지 않는다**. 다만 이미 입력 중이면
  (`document.activeElement`가 입력창) 다음 단어로 넘어갈 때 다시 포커스한다 —
  안 그러면 한 단어 쓸 때마다 키보드가 내려간다.

## 간격 반복 복습 (`오늘 복습`)

오답은 `wrong_count` 만 쌓는 게 아니라 **다음에 볼 날짜**를 갖는다.
`next_review_date <= 오늘` 인 단어가 대시보드의 `오늘 복습` 에 모인다.

- 오답이면 `wrong_count` 에 따라 1개 → 3일, 2개 → 2일, 3개 이상 → 1일 뒤.
  틀릴수록 자주 나오게 하는 게 목적이다
- 정답이면 7일 뒤로 밀되 `wrong_count` 는 그대로 둔다
- **정답 2회 연속**이어야 `mastered_words` 로 졸업한다 (`GRADUATE_STREAK`).
  4지선다는 찍어서 맞을 확률이 25% 라 한 번으로는 안 된다.
  오답이 하나라도 끼면 `correct_streak` 는 0으로 돌아간다

### `showFeedback` 에 채점을 넣지 말 것

`showFeedback` 은 **렌더 함수**다. 답을 낸 문제로 이전/다음 버튼을 눌러
되돌아올 때마다 다시 호출된다 (`renderQuizQuestion` 안 두 곳). 예전의
`setMastered` 는 멱등이라 아무 일도 없었지만, `Store.recordCorrect` 는
연속 횟수를 올리므로 여기 두면 **문제를 한 번만 맞히고도 버튼을 왕복해서
졸업시킬 수 있다**. 채점은 `applyCorrectAnswer` 가 제출 경로에서만 하고,
`word.scored` 로 한 번 더 막는다.

### 복습 출제량 상한

만기 단어를 전부 내면 안 된다. 마이그레이션 백필이 기존 70개를 **전부 같은
날 만기**로 만들기 때문에, 상한이 없으면 첫날 70문항(15분 이상)이 나오고
그날의 새 단어 학습이 통째로 밀린다.

기본 20문항 (`REVIEW_QUIZ_LIMIT_DEFAULT`, `voca_review_limit` 로 조정).
`Store.getDueIncorrect()` 가 **많이 틀린 순 → 오래 밀린 순**으로 정렬해서
상한이 걸려도 제일 안 외워진 단어가 먼저 나간다.

배지는 만기 **총 개수**를 보여준다. 상한을 넘으면 `20 / 70` 처럼 적어서
남은 양이 보이게 한다 — 출제 수만 보여주면 밀린 게 없는 것처럼 보인다.

`voca_review_limit` 은 `voca_tracing_hints` 와 같은 이유로 `Store` 밖에 있다.
이 기기가 하루에 몇 문제를 내는지는 학습 기록이 아니라서 동기화 페이로드에
낄 이유가 없다.

### 옛 레코드는 "오늘 만기"로 본다

`next_review_date` 가 없는 localStorage 레코드(구버전이 쓴 것)는 오늘 날짜로
간주한다 — `store.js` 의 `normalizeIncorrect` 한 곳에서만 처리한다. 숨기는
쪽으로 폴백하면 업데이트 직후 이미 기다리던 단어가 사라진다. 서버도 같은
규칙이다 (`_read_sync_state`, 그리고 병합의 `or row[...]` 폴백 — 새 필드를
모르는 클라이언트가 LWW 에서 이겨도 값을 지우지 않는다).

날짜는 **로컬 캘린더 날짜**다. `updated_at` 의 UTC 타임스탬프와 다르다 —
"오늘"은 사용자가 보고 있는 벽시계여야 한다.

## 건드릴 때 주의할 것

각 항목은 실제로 한 번씩 깨졌던 것들이다.

### 오답노트는 hard delete 금지
`incorrect_words`는 `deleted=1` 툼스톤으로만 지운다. 실제로 `DELETE` 하면
반대편에 남아 있던 행 때문에 **다음 동기화에서 되살아난다**. 조회는 전부
`WHERE COALESCE(deleted, 0) = 0`.

### `wrong_count`에 LWW를 쓰지 말 것
단조 증가 카운터라 최신값만 취하면 반대쪽에 쌓인 오답이 사라진다. `max()`.

### CORS 헤더는 `end_headers()` 한 곳에서만
iOS WebView는 `capacitor://localhost` origin이라 GET까지 전부 cross-origin이다.
개별 핸들러에서 `Access-Control-Allow-Origin`을 또 붙이면 헤더가 **중복**되고
WebView가 preflight를 거부한다. 증상이 조용해서 찾기 어렵다 —
서버 로그에 `OPTIONS /api/sync 200`은 찍히는데 POST가 영영 안 온다.
현재 `run.py:358` 단 한 곳.

### 서버는 IPv4 전용으로 바인딩하지 말 것
`socketserver.TCPServer`의 기본값이 IPv4 전용이라 **셀룰러 핫스팟에서 폰이
Mac을 아예 못 본다**. 통신사가 IPv6 전용이면 핫스팟은 IPv4 리스를 하나도
주지 않고, 이때 Mac에 붙는 `192.0.0.2/32`는 464XLAT이 만든 합성 CLAT
주소라 폰에서 라우팅이 안 된다. 회사 Wi-Fi가 기기 간 통신을 막아서
핫스팟으로 우회하는 바로 그 상황이 사각지대였다.

`DualStackTCPServer`가 `::`에 바인딩하고 `IPV6_V6ONLY`를 끈다. 평범한 IPv4
LAN은 v4-mapped 경로로 그대로 동작한다.

증상이 헷갈린다 — Mac에서 `curl`로 자기 주소를 때리면 200이 나온다.
루프백이라 실제 경로를 전혀 검증하지 못한다.

### 접속 주소는 `print_reachable_urls()`가 알려준다
망을 옮길 때마다 폰 설정에 넣을 주소가 바뀐다. 서버 시작 시 출력한다.
다음 세 종류는 **일부러 제외**한다 (찍히면 헛다리를 짚게 된다):

- `192.0.0.x` — 위의 합성 CLAT 주소. LAN 주소처럼 생겼는데 안 닿는다
- IPv6 `temporary` — 몇 시간 내 회전하므로 앱 설정에 저장하면 나중에 깨진다.
  `autoconf secured` 안정 주소만 남긴다
- `127.x`, `169.254.x`

### 타임스탬프 포맷
JS `Date.toISOString()`과 **문자열 비교**로 병합하므로 모양이 같아야 한다.
밀리초 3자리 UTC. `utc_now_iso()` 를 쓰고 `isoformat()`을 쓰지 말 것
(마이크로초 6자리가 나온다).

### `.bg-glow`는 `position: fixed` 유지
600px 폭으로 화면 양쪽에 일부러 걸쳐 놓은 장식이다. `absolute`로 되돌리면
오버행이 문서 `scrollWidth`에 포함돼 **오른쪽에 빈 여백이 스크롤된다**
(393px 뷰포트에서 561px). `body`의 `overflow-x: hidden`으로는 안 막히고,
`html`에도 걸려 있어야 한다.

### 경로를 하드코딩하지 말 것
`run.py`와 `parse_words.py`가 `/Users/dykim/Documents/토익 단어장` 을 박아 두고
있었는데, 프로젝트가 옮겨지면서 **존재하지 않는 경로**가 됐다. 증상이 사방으로
번진다 — 엑셀 파싱 실패, 서버가 모든 요청에 404, `toeic` 별칭까지 같이 죽는다.
게다가 옛 경로를 보는 서버가 계속 떠 있으면 포트만 물고 404를 뱉어서
"왜 앱이 안 되지" 로 한참 헤맨다.

지금은 둘 다 `os.path.dirname(os.path.dirname(os.path.abspath(__file__)))` 로
자기 위치에서 유도한다. `~/.zshrc` 의 `toeic` 별칭만 절대 경로를 안다.

### `web/index.html`, `run.py`, `parse_words.py`는 NFD 정규화 파일
한글이 자소 분리 저장이라 Edit 도구의 문자열 매칭이 **조용히 실패한다**.
ASCII 앵커로 잡거나, Python에서 `unicodedata.normalize`로 양쪽 형태를 시도할 것.

```bash
python3 -c "import unicodedata,sys; s=open(sys.argv[1],encoding='utf-8').read(); print(unicodedata.is_normalized('NFC',s))" web/index.html
```

### `ios/App/App/public/` 를 직접 고치지 말 것
`npx cap copy ios`가 `web/`에서 덮어쓰는 사본이다. 원본은 항상 `web/`.

### Xcode ▶ Run 은 `cap copy` 를 하지 않는다
서명 갱신용으로 Xcode Run 을 써도 되고, 빌드 산출물이 `~/Library` 아래라
아래의 iCloud 서명 문제도 안 걸린다. 다만 Xcode 는 `ios/App/App/public/` 에
**이미 복사돼 있는 것**을 빌드한다. `web/` 을 고친 뒤 그냥 Run 하면 옛 코드가
설치되고, 아무 오류도 안 난다. `resign-ios.sh` 는 이걸 자동으로 한다.

### 스토리보드 XML 주석에 `--` 금지
`LaunchScreen.storyboard` 주석에 하이픈 두 개를 넣으면
`Double hyphen within comment`로 빌드가 깨진다. CSS 변수명(`--bg-primary`)을
주석에 적다가 걸렸다.

### 빌드 산출물을 프로젝트 안에 두지 말 것

`~/Documents`가 iCloud Drive 동기화 루트라(Desktop & Documents 동기화) 파일
프로바이더가 ibtool이 만든 `.storyboardc` 디렉터리에 `com.apple.FinderInfo`를
붙인다. codesign은 이게 붙은 걸 서명하지 않는다:

```
App.app: resource fork, Finder information, or similar detritus not allowed
Command CodeSign failed with a nonzero exit code
```

컴파일·링크가 전부 끝난 **맨 마지막 단계에서** 터져서 코드 문제처럼 보인다.
`xattr -cr` 로 지워도 파일 프로바이더가 다시 붙이므로 소용이 없다.
`resign-ios.sh`의 `DERIVED`가 `~/Library/Developer/VocaTrainer/build`를 가리킨다 —
`~/Library`는 동기화되지 않는다. 프로젝트 안의 `build/`는 이 이전의 잔재다.

```bash
xattr -lr <경로> | grep FinderInfo    # 의심되면 이걸로 확인
```

### `xcodebuild` 출력을 파이프로 자르지 말 것
`| tail -2` 같은 걸 붙이면 종료 코드가 파이프 마지막 명령 것으로 바뀌어
BUILD FAILED가 성공처럼 보인다. `grep -E "error:|BUILD (SUCCEEDED|FAILED)"`.

### `devicectl` 기기 파싱
컬럼은 `Name Hostname Identifier State Model`이고 Model에 공백이 있어
뒤에서 세면 틀린다. State는 **정확히 일치**로 봐야 한다 — 부분 문자열로
`connected`를 찾으면 `disconnected`도 걸린다.

```bash
xcrun devicectl list devices | awk '$4 == "connected" {print $3}'
```

**무선 연결된 폰은 이 필터에 안 걸린다.** USB 로 꽂혀 있을 때만 `connected`
이고, Wi-Fi 로 페어링된 상태는 `available (paired)` 다. 그래서
`./resign-ios.sh` 를 인자 없이 돌리면 "연결된 iPhone을 찾지 못했습니다" 가
뜬다. 기기 ID 를 직접 넘기면 무선으로도 빌드·설치가 그대로 된다 — 검증됨.

```bash
./resign-ios.sh 65414168-444A-54C4-816B-091D5C911E68   # dykim_iPhone
```

## 무료 Apple ID 제약

인증서 7일, 앱 ID 주당 10개, 기기당 앱 3개. 7일 지나면 앱이 실행 직후 튕기며,
`./resign-ios.sh`로 재설치해야 한다. 최초 1회는 Xcode에서 팀 서명 설정 필요.

Xcode ▶ Run 도 똑같이 서명을 갱신한다 (기기 UUID 를 안 외워도 된다는 게 장점).
위의 `cap copy` 주의사항만 지킬 것. 남은 기간 확인:

```bash
security cms -D -i ~/Library/Developer/VocaTrainer/build/Build/Products/Debug-iphoneos/App.app/embedded.mobileprovision \
  | plutil -extract ExpirationDate raw -
```

## 검증

- 로컬 네트워크 권한 프롬프트는 **시뮬레이터에서 안 뜬다**. 실기기 필요
- WKWebView는 `console.log`가 `log stream`에 잡히지 않는다. 화면에 값을
  그려서 스크린샷으로 읽는 편이 빠르다
- 엑셀 백업은 `오답노트` 시트만 갈아끼우고 다른 시트는 보존해야 한다
