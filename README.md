# Highlight Mirror for Zotero

번역 노트에서 하이라이트하면 **원문 PDF의 같은 자리에 하이라이트 주석**이 달리고, 댓글에 번역문이 들어갑니다.
원문 PDF를 **Claude API로 단락 단위 번역**해 노트로 만드는 기능도 들어 있습니다.

- 대상: Zotero 7 이상 (10.0.x에서 개발)
- 빌드 도구 없음: 순수 JS, `python build.py` 한 줄로 xpi 생성
- 저장 위치: 번역문·주석은 사용자의 Zotero 라이브러리 안에만, 상태 파일은 Zotero 데이터 폴더의 `highlight-mirror/`에만 저장

## 설치

1. `python build.py` → `dist/highlight-mirror-0.1.0.xpi`
2. Zotero → 도구 → 플러그인 → 톱니바퀴 → **Install Plugin From File…** → xpi 선택
3. Zotero → 설정 → **Highlight Mirror** → Claude API 키 입력 → **연결 테스트**

## 사용

| 하고 싶은 것 | 방법 |
|---|---|
| 번역 노트의 하이라이트를 PDF에 반영 | 아이템(또는 노트) 우클릭 → **노트 하이라이트 → PDF 주석** |
| 노트를 고칠 때마다 자동 반영 | 기본값 켜짐 (설정에서 끌 수 있음). 노트 저장 후 약 4초 뒤 새 하이라이트만 처리 |
| 원문 PDF를 번역 노트로 | 아이템 우클릭 → **원문 PDF → 번역 노트 (Claude)** |
| 플러그인이 만든 주석만 지우기 | 설정 → "이 플러그인이 만든 주석 모두 삭제" (태그 `highlight-mirror` 기준) |

## 동작 원리

1. **노트 파싱** — 노트 HTML에서 `background-color` span을 모아 하이라이트 목록을 만든다. 같은 단락 안에서 이어진 span은 하나로 합친다. 각 하이라이트는 텍스트 해시로 식별해 중복 처리를 막는다.
2. **PDF 텍스트 좌표** — Zotero에 내장된 pdf.js(`resource://zotero/reader/pdf/build/pdf.mjs`)를 불러 페이지별 단어 좌표를 뽑는다. 좌표계는 Zotero 주석과 같은 PDF 사용자 공간(왼쪽 아래 원점).
3. **원문 찾기** — 하이라이트 텍스트가 PDF에 그대로 있으면 바로 쓰고, 아니면(번역문이면) Claude에게 문서 전문과 하이라이트 목록을 주고 **원문 구절을 verbatim으로** 돌려받는다. 한 원문 문장 안의 여러 구절(예: "무엇이 알려져 있는가 / 누가 / 어디서…")도 각각 따로 찾는다.
4. **좌표 매핑** — 영숫자만 남긴 정규화 문자열로 인용문을 단어열에서 찾고(줄바꿈·하이픈 분리·따옴표 차이 흡수), 같은 줄 단어들을 한 rect로 합친다.
5. **주석 생성** — `Zotero.Item('annotation')`을 PDF 첨부의 자식으로 저장. 리더에 즉시 표시되고 동기화도 된다.
6. **자동 갱신** — `Zotero.Notifier`로 노트 수정 이벤트를 받아 디바운스 후 처리. 처리 기록은 노트별 JSON(`note-<lib>-<key>.json`)에 남아 **새로 생긴 하이라이트만** 처리한다. 옵션으로 노트에서 지운 하이라이트의 주석도 삭제.

번역 노트 생성 시에는 단락별 원문 첫 10단어와 페이지를 대응표(`map-<lib>-<key>.json`)로 저장해, 이후 하이라이트 매칭에 힌트로 쓴다.

## Claude API와 번역 거부에 대해

채팅 Claude는 논문 전문 번역을 재배포 우려로 거부할 수 있습니다. 이 플러그인은
- 시스템 프롬프트에 **사용자가 합법 보유한 논문, 개인 연구 노트, 라이브러리 밖으로 나가지 않음**을 명시하고,
- 전문을 한 번에 보내지 않고 **단락 묶음(약 7,000자)** 으로 나누어 요청하며,
- Opus/Sonnet 5.5에서는 서버 측 폴백(`fallbacks: "default"`)을 켜서 분류기 거부 시 다른 모델로 자동 재시도합니다.

그래도 거부되면 해당 구간 오류로 표시되니 더 작게 나누어 다시 시도하세요. 번역문은 개인 연구용으로만 쓰고 배포하지 마세요.

기본 모델은 `claude-opus-5-5`입니다. 비용을 줄이려면 설정에서 Sonnet 5.5나 Haiku 5.5로 바꿀 수 있습니다. 하이라이트 매칭 한 번은 논문 전문(약 1만~2만 토큰)을 보내므로 Opus 기준 수십 원, 전문 번역은 수백 원 정도입니다.

## 검증 상태

Zotero 10.0.7(Windows)에서 확인한 것:

- 플러그인 로드, 메뉴·설정창 등록, Notifier 등록
- 내장 pdf.js 5.7.0 로딩 (창 컨텍스트 `import()` 경로로 성공, `ChromeUtils.importESModule`은 실패 → 로그에 남음)
- 15쪽 논문에서 단어 6,865개 좌표 추출, 줄 끝 하이픈으로 갈라진 문장과 긴 문장 안의 짧은 구절 모두 적중
- 번역 노트에서 하이라이트 9개 추출 (색 포함)

아직 사용자 환경에서 확인이 필요한 것: Claude 호출이 들어가는 실제 동기화와 번역 노트 생성(API 키 필요).

문제가 생기면 설정 → **디버그 로그 보기** 에서 `[HighlightMirror]` 줄을 보거나, 아래 로컬 엔드포인트로 단계별 확인을 할 수 있습니다.

## 로컬 테스트 엔드포인트

Zotero 커넥터 서버(기본 `http://localhost:23119`, 이 컴퓨터에서만 접근 가능)에 다음 경로가 추가됩니다. 외부 스크립트나 다른 도구에서 미러링을 트리거할 때도 쓸 수 있습니다.

| 경로 | 설명 |
|---|---|
| `GET /highlight-mirror/status` | 버전, 모델, 키 유무, pdf.js 로딩 상태 |
| `GET /highlight-mirror/locate?item=<PDF key>&q=<원문 구절>[&page=n]` | 좌표 매칭 드라이런 (Claude 호출 없음) |
| `GET /highlight-mirror/highlights?note=<note key>` | 노트에서 뽑은 하이라이트 목록 |
| `POST /highlight-mirror/sync` `{"note":"<note key>"}` | 실제 미러링 실행, 처리 상태 반환 |
| `POST /highlight-mirror/translate` `{"item":"<parent key>"}` | 번역 노트 생성 |

```bash
curl "http://localhost:23119/highlight-mirror/status"
```

## 개발용 설치 (xpi 없이 소스 폴더를 바로)

1. Zotero 종료
2. 프로필 폴더(`%APPDATA%\Zotero\Zotero\Profiles\<xxx>.default`)의 `extensions/` 안에 `highlight-mirror@songhee.kr` 라는 **확장자 없는 텍스트 파일**을 만들고, 내용으로 이 저장소 폴더의 절대 경로(끝에 `\`)만 적는다
3. 같은 프로필의 `prefs.js`에서 `extensions.lastAppBuildId`, `extensions.lastAppVersion` 줄을 지우고 `user_pref("extensions.autoDisableScopes", 0);` 을 추가한다 (사이드로드 플러그인이 자동 비활성되는 것을 막음)
4. Zotero 실행. 코드를 고친 뒤에는 Zotero를 다시 시작하면 반영된다

## 배포

- GitHub 저장소를 만들고 Release에 xpi를 올리면 끝입니다. 자동 업데이트까지 하려면 `updates.json`을 저장소에 두고 `manifest.json`의 `applications.zotero.update_url`에 그 raw URL을 넣으세요.
- 플러그인 ID `highlight-mirror@songhee.kr`는 바꾸지 마세요(바꾸면 다른 플러그인으로 인식됩니다).
- Zotero 플러그인 목록(zotero.org/support/plugins)에 등록 신청하면 포럼 사용자에게 노출됩니다.

## 파일 구성

```
manifest.json            플러그인 메타데이터 (Zotero 7+ 형식)
bootstrap.js             startup/shutdown, 메뉴·설정창 등록
prefs.js                 기본 설정값
content/highlightMirror.js   본체 (noteParser / pdfText / matcher / claude / annotator / state / prefs)
content/preferences.xhtml    설정 창
build.py                 xpi 패키징
```

## 로드맵

- 하이라이트를 PDF 쪽에서 지우면 노트 쪽에도 반영 (양방향)
- 리더 사이드바에 "번역 보기" 패널 (주석 댓글 대신)
- 번역 노트에 원문 단락 ID를 숨겨 두어 Claude 호출 없이 즉시 매칭
- 그룹 라이브러리 지원 (현재 상태 파일은 라이브러리 ID별이라 동작은 하지만 테스트 안 됨)
