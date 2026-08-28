# iOS 앱 (Capacitor)

기존 웹 앱을 그대로 감싼 iOS 네이티브 앱입니다. UI 코드는 `web/` 하나뿐이고,
Mac 브라우저와 iPhone 앱이 같은 파일을 공유합니다.

---

## 1. 최초 1회 설정 (Xcode)

무료 Apple ID로 서명하려면 처음 한 번은 Xcode를 거쳐야 합니다.

```bash
open ios/App/App.xcodeproj
```

1. 왼쪽 트리에서 **App** 프로젝트 → **TARGETS: App** 선택
2. **Signing & Capabilities** 탭
3. **Automatically manage signing** 체크
4. **Team** → *Add an Account…* → 본인 Apple ID 로그인 → 개인 팀 선택
5. **Bundle Identifier**가 `com.dykim.vocatrainer` 인지 확인
   (다른 사람이 이미 쓴 ID면 충돌하니, 오류가 나면 뒤에 숫자를 붙이세요)
6. iPhone을 USB로 연결하고 상단 실행 대상으로 선택 → **▶ Run**

앱이 설치된 뒤 iPhone에서 한 번만:
**설정 → 일반 → VPN 및 기기 관리 → 개발자 앱 → 신뢰**

---

## 2. 매주 재설치 (7일마다)

무료 프로비저닝 인증서는 **7일 뒤 만료**되어 앱이 실행되지 않습니다.
iPhone을 연결한 뒤 이 스크립트를 돌리면 Xcode를 열지 않고 갱신됩니다.

```bash
./resign-ios.sh
```

연결된 기기를 자동으로 찾습니다. 여러 대가 붙어 있으면 직접 지정하세요.

```bash
xcrun devicectl list devices     # ID 확인
./resign-ios.sh <device-id>
```

> 무료 계정 제한: 인증서 7일, 등록 가능한 앱 ID 주당 10개, 기기당 앱 3개.
> 이 제한이 번거로워지면 Apple Developer Program(연 $99)으로 올리면
> 인증서가 1년으로 늘어나고 이 과정이 사라집니다.

---

## 3. 단어를 추가했을 때

```bash
# Mac에서
python3 run.py          # 엑셀 → data.json 재생성 + 서버 시작
```

그다음 iPhone 앱에서 **동기화 버튼(⟳)** 한 번. 끝입니다.
앱을 다시 빌드할 필요는 없습니다 — 단어 데이터는 동기화로 받아옵니다.

앱 화면 자체(HTML/CSS/JS)를 고쳤을 때만 재빌드가 필요합니다.

```bash
npx cap copy ios && ./resign-ios.sh
```

---

## 4. 동기화 동작 방식

iPhone은 **오프라인에서 완전히 동작**합니다. 퀴즈를 풀고 오답이 쌓이는 것은
전부 기기 안(localStorage)에서 일어나고, Mac은 동기화할 때만 개입합니다.

### 데이터 흐름

```
엑셀(.xlsx) ──parse_words.py──> data.json ──┐
                                            ├──> /api/sync ──> iPhone
voca.db (오답노트 · 완료 단어) ─────────────┘         ▲
                                                     │
                          iPhone에서 쌓인 오답/완료 ──┘
```

- **단어 데이터**는 Mac이 원본입니다 (엑셀 → 폰, 단방향)
- **오답노트와 완료 단어**는 양방향입니다

### 충돌 처리

단어마다 `updated_at` 타임스탬프와 `deleted` 표시를 들고 다닙니다.

- 같은 단어가 양쪽에서 바뀌었으면 **타임스탬프가 최신인 쪽**이 이깁니다
- `틀린 횟수`만은 예외로 **양쪽 중 큰 값**을 씁니다 (단조 증가 카운터라,
  최신값만 취하면 반대쪽에 쌓인 오답이 사라집니다)
- 맞혀서 졸업시킨 단어는 실제로 지우지 않고 `deleted=1`로 표시만 합니다.
  그냥 지우면 다음 동기화 때 상대편에 남아 있던 행 때문에 **되살아납니다**

### 서버 주소

기본값은 `http://dykimMacBook-Pro.local:8080` 입니다. Bonjour 이름이라
공유기가 IP를 바꿔도 그대로 동작합니다. 앱의 **설정(⚙️)** 에서 바꿀 수 있습니다.

동기화 조건:
- Mac에서 `run.py`가 실행 중일 것
- iPhone과 Mac이 **같은 Wi-Fi**에 있을 것
- 첫 실행 시 iOS가 로컬 네트워크 접근을 물어보면 **허용**

앱 실행 시 자동으로 한 번 조용히 동기화를 시도합니다. Mac이 꺼져 있으면
아무 메시지 없이 넘어가고, 로컬에 쌓인 기록은 다음 동기화 때 올라갑니다.

---

## 5. 엑셀 백업

앱 **설정 → 오답노트 엑셀 백업**을 누르면 동기화 후 Mac의
`토익 단어장.xlsx` → `오답노트` 시트에 기록합니다. 다른 시트는 보존됩니다.

`run.py`가 실행 중이어야 동작합니다.

---

## 6. 문제 해결

| 증상 | 확인할 것 |
|---|---|
| 앱이 실행 직후 튕김 | 7일 인증서 만료. `./resign-ios.sh` 재실행 |
| "신뢰할 수 없는 개발자" | 설정 → 일반 → VPN 및 기기 관리 → 신뢰 |
| 동기화 시간 초과 | `run.py` 실행 중인지, 같은 Wi-Fi인지 확인 |
| 동기화 시 네트워크 오류 | iOS 설정 → Voca Trainer → 로컬 네트워크 허용 확인 |
| 단어가 예전 그대로 | Mac에서 `run.py`를 다시 돌린 뒤 앱에서 동기화 |
| 기기를 못 찾음 | `xcrun devicectl list devices` 로 ID 확인 후 인자로 전달 |

---

## 7. 파일 구조

```
voca-practice/
├── web/                  # 앱 UI (Mac 브라우저와 iOS가 공유)
│   ├── index.html
│   ├── app.js            # 화면 로직
│   ├── store.js          # 로컬 저장소 + 동기화 클라이언트
│   ├── style.css
│   └── data.json         # 엑셀에서 생성된 단어 데이터
├── ios/App/              # Capacitor가 만든 Xcode 프로젝트
├── run.py                # 로컬 서버 + 동기화 API
├── parse_words.py        # 엑셀 → data.json 변환
├── voca.db               # 오답노트 · 완료 단어 (원본)
├── resign-ios.sh         # 주간 재서명 스크립트
└── capacitor.config.json
```
