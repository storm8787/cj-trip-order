# 충주 업무도구함 출장 도구 연동 안내

현재 저장소는 `storm8787/cj-trip-order`입니다. 업무도구함 소스는 연결되어 있지 않습니다.
이 변경은 기존 Render 서버에 검색 API와 선택적 로컬 파일 CORS 지원을 추가하며,
업무도구함 자체의 통합·Render 설정 변경·운영 배포는 수행하지 않습니다.

## 연결 구조와 유지 범위

```text
업무도구함 HTML(file:// 또는 허용한 HTTPS 출처)
  ├─ 검색 → Render GET /api/search → 카카오 Local API
  │        ← 장소명·주소·숫자 위도/경도
  ├─ 사용자가 출발지·출장지 선택
  ├─ 거리표 → Render POST /api/matrix → 카카오모빌리티
  │          ← 방향별 미터·초 거리표
  └─ 업무도구함 내부에서 방문순서 계산·복귀 여부 반영
```

REST 키는 Render의 `KAKAO_REST_API_KEY`만 사용합니다. HTML에 포함하거나 직원에게
입력을 요구하지 않습니다. 새 서버·DB·로그인은 없습니다.
기존 Render 루트의 출장 추천 화면과 `/api/config`, `/api/health`, `/api/matrix` 응답 계약은 유지합니다.
기존 HTML의 SDK 검색, `file://`에서 `/api/config`를 건너뛰는 동작, 전수 비교 계산은 변경하지 않습니다.
이 문서의 서버 검색 연동을 **기존 HTML에 자동 적용한 것은 아닙니다**.

## 카카오 계약의 근거와 운영 전 확인

출처: [카카오 Local REST API 공식 문서](https://developers.kakao.com/docs/ko/local/dev-guide).
확인일: 2026-11-24. **외부에서 공식 문서를 확인해 전달받은 요약 기준**으로 구현했습니다.
이 클라우드에서 공식 문서에 직접 접근한 것으로 기록하지 않습니다.

- 키워드: `GET https://dapi.kakao.com/v2/local/search/keyword.json`
- 주소: `GET https://dapi.kakao.com/v2/local/search/address.json`
- 인증: 서버에서 `Authorization: KakaoAK ${KAKAO_REST_API_KEY}`
- `x`는 경도(`lng`), `y`는 위도(`lat`). 주소검색에 장소 ID가 있다고 가정하지 않습니다.
- 페이지는 1~45, size는 키워드 1~15(기본 15), 주소 1~30(기본 10).
- 거리순 정렬·기준좌표·임의 URL 전달 기능은 제공하지 않습니다. 카카오 기본 정확도순 검색을 사용합니다.

기존 REST 키를 우선 재사용하되, 해당 앱/키의 **Local API 이용 설정·권한**과
카카오모빌리티 길찾기 권한은 각각 관리자가 확인해야 합니다.
실제 키의 Local API 이용 가능 여부, 실제 응답 성공, 무료 쿼터·과금 조건은 미확인입니다.
유료 서비스나 자동 과금은 활성화하지 않습니다. 문서 규격 확인은 실제 연동 성공과 다릅니다.

## Render 설정 제안

다음은 운영 담당자가 검토할 값이며 아직 적용하지 않았습니다.
기존 `node server/server.mjs` 시작 명령을 그대로 사용합니다.

| 변수 | 예시값 | 용도 |
|---|---|---|
| `KAKAO_REST_API_KEY` | 기존 Render 보안 값 재사용 | Local 검색·길찾기, 실제 키를 문서에 기록하지 않음 |
| `KAKAO_JAVASCRIPT_KEY` | 기존 값 유지 | 기존 사이트 SDK 검색용. 업무도구함 REST 검색에는 불필요 |
| `ALLOW_FILE_ORIGIN` | `true` | 로컬 HTML 연결 시에만 켬. 기본 `false` |
| `ALLOWED_ORIGINS` | `https://tools.example.org` | 별도 웹페이지의 정확한 출처. 여러 출처는 쉼표 구분, 경로·끝 슬래시 제외 |
| `SEARCH_RATE_LIMIT_PER_MIN` | `30` | IP당 분당 유효 검색 요청 제한 |
| `SEARCH_DAILY_CALL_BUDGET` | `1000` | 프로세스의 검색 외부 호출 상한. `0`이면 외부 검색 중지 |
| `SEARCH_TIMEOUT_MS` | `5000` | 검색 응답 본문 읽기까지의 타임아웃(ms) |
| `SEARCH_UPSTREAM_CONCURRENCY` | `4` | 서버 전체 동시 검색 외부 호출 수 |

기존 길찾기 변수와 수치 범위는 [도로거리 서버 문서](ROAD_DISTANCE.md#3-환경변수)를 참고하세요.
프로세스의 인터넷 접근에 `dapi.kakao.com`(검색), `apis-navi.kakaomobility.com`(길찾기)이 필요합니다.
`KAKAO_LOCAL_BASE`는 루프백 Mock 테스트 전용이며 운영에서는 설정하지 않습니다.

### 로컬 파일과 웹 출처

- 브라우저로 `file://` HTML에서 fetch할 때 실제 요청의 `Origin: null`을 테스트합니다.
  `ALLOW_FILE_ORIGIN=true`일 때만 `Access-Control-Allow-Origin: null`을 반환합니다.
- 기본값은 꺼짐입니다. `ALLOWED_ORIGINS=null` 또는 기존 `*` 설정만으로 로컬 연결을 켤 수 없습니다.
- `null`은 sandbox 문서 등 다른 불투명 출처도 포함합니다. 특정 업무도구함 파일을 인증하지 않습니다.
- 같은 출처 사이트는 허용하며, Render TLS 종료 뒤에는 `X-Forwarded-Proto: https`를 고려합니다.
- 외부 웹 출처는 `ALLOWED_ORIGINS`로 명시합니다. 기존 `*`의 웹 출처 호환 처리는 유지하지만
  로컬 연결을 위해 `*`를 새로 설정하지 않습니다.
- OPTIONS는 GET/POST와 `Content-Type`만 허용합니다. 쿠키·로그인 자격증명 헤더를 사용하지 않으며
  `Access-Control-Allow-Credentials`는 반환하지 않습니다. 클라이언트는 `credentials: 'omit'`을 씁니다.
- 허용한 출처는 API 실패 응답도 읽을 수 있습니다. 허용하지 않은 출처는 403이며,
  브라우저에서는 CORS로 본문을 읽을 수 없습니다.

**CORS는 사용자 인증이나 카카오 사용량 보호 장치가 아닙니다.** 비브라우저 클라이언트는
Origin을 생략하거나 위조할 수 있습니다. IP별 제한 역시 프록시가 전달하는 IP의 신뢰 설정에
영향을 받습니다. 글로벌 호출 상한·카카오 사용량 모니터링을 병행해야 합니다.

## 검색 API

```http
GET /api/search?type=keyword&query=충주시청&page=1&size=15
GET /api/search?type=address&query=충주시%20으뜸로%2021&page=1&size=10
```

| 입력 | 계약 |
|---|---|
| `type` | 필수, `keyword` 또는 `address` |
| `query` | 필수, 앞뒤 공백 제거 후 1~100 유니코드 코드포인트. 제어문자 거부 |
| `page` | 선택, 기본 1, 1~45 정수 |
| `size` | 선택, 키워드 기본 15/최대 15, 주소 기본 10/최대 30, 최소 1 |

중복 파라미터·알 수 없는 파라미터·빈 값·소수·음수는 거부합니다.
요청 URL은 4096바이트까지 허용합니다. `url` 등 임의 대상 지정은 지원하지 않습니다.

아래는 **응답 형식 설명용 예시**이며 실제 카카오 조회 결과가 아닙니다.

```json
{
  "items": [
    {
      "id": "example-place-id",
      "name": "검색 응답의 장소명",
      "roadAddress": "검색 응답의 도로명주소",
      "address": "검색 응답의 지번주소",
      "lat": 36.99,
      "lng": 127.92
    }
  ],
  "page": 1,
  "hasMore": false,
  "omittedCount": 0
}
```

| 필드 | 의미 |
|---|---|
| `items` | 현재 페이지에서 좌표가 유효한 선택 가능 항목. 현재 결과 수는 `items.length` |
| `id` | 키워드 검색 응답의 문자열 ID, 없거나 주소검색이면 `null`. 주소에 가짜 ID 생성 금지 |
| `name` | 키워드의 `place_name`. 주소는 `road_address.building_name` → `address_name` → `address.address_name` 순으로 **응답에 있는 문자열** 사용. 전부 없으면 빈 문자열 |
| `roadAddress` | 키워드 `road_address_name` 또는 주소 `road_address.address_name`. 없으면 빈 문자열 |
| `address` | 키워드 `address_name` 또는 주소 `address.address_name`(없으면 최상위 `address_name`). 없으면 빈 문자열 |
| `lat`, `lng` | 각각 위도·경도 숫자. 유한수 및 위도 -90~90, 경도 -180~180 검증 |
| `page` | 요청한 현재 페이지 |
| `hasMore` | 카카오 `meta.is_end === false`이고 현재 page < 45인 경우만 true |
| `omittedCount` | 현재 상위 응답에서 좌표 누락·빈 값·잘못된 수치로 제외한 건수 |

누락 필드는 빈 문자열/`null`로 표시하며 명칭·주소·좌표를 지어내지 않습니다.
`meta.total_count`(전체 검색 수)와 `meta.pageable_count`(노출 가능 수)는 다르므로
이 API에서는 총건수로 옮기지 않습니다. 다음 페이지는 `hasMore`만 보고 요청하세요.
좌표 제외로 항목 수가 줄어도 원래 `meta.is_end`와 페이지 상한을 따릅니다.

- 200 + 빈 `items` + `omittedCount: 0`: 검색 결과 없음.
- 200 + `omittedCount > 0`: “좌표가 없는 결과 N건을 제외했습니다” 안내. 전부 제외됐으면 “선택 가능한 좌표 결과 없음”.
- 비정상 HTTP: 검색 실패. 결과 없음으로 표시하거나 임의 장소로 대체하지 않습니다.
- 정상 빈 목록에 대해 서버가 다른 검색 방식을 자동 재호출하지 않습니다. 사용자가 방식을 바꾸거나 다시 요청합니다.

## 도로거리 API: 기존 계약 유지

```http
POST /api/matrix
Content-Type: application/json
```

```json
{"points":[{"lat":36.99,"lng":127.92},{"lat":36.98,"lng":127.93}]}
```

아래 수치는 Mock 예시입니다.

```json
{
  "matrix": [
    [{"distance":0,"duration":0},{"distance":1200,"duration":120}],
    [{"distance":1800,"duration":180},{"distance":0,"duration":0}]
  ],
  "missing": [],
  "stats": {"multiCalls":2,"singleCalls":0,"pairs":2,"outOfRadius":0},
  "priority":"DISTANCE",
  "provider":"카카오모빌리티 길찾기"
}
```

- `points[0]`은 출발지, 나머지는 출장지. 기본 최대 9지점(출발지 1 + 출장지 8), 최소 2.
- 서버의 현행 좌표 범위는 위도 33~39.5, 경도 124~132입니다.
- `matrix[i][j]`는 입력 순서 i→j의 **거리 m / 시간 s**. 비대칭이므로 반대 방향을 복사하지 않습니다.
- 최적화에 km 단위를 사용한다면 `distance / 1000`으로 변환합니다. 시간은 초를 유지합니다.
- 복귀 여부는 업무도구함 내부 최적화에서 마지막→출발지 포함 여부로 처리합니다.
- `missing`은 `{from, to}` 인덱스 목록이며 해당 행렬 항목은 `null`입니다.
  HTTP 200이어도 `missing`이 하나라도 있으면 도로거리 결과를 계산하지 않습니다.
  직선거리로 몰래 채우지 말고, 실패 구간을 안내한 후 사용자가 명시적으로 직선거리 재계산을 선택하게 합니다.
- 방문순서 후보마다 서버를 호출하지 않습니다. 한 번 받은 방향별 행렬로 내부 전수 비교합니다.
- `GET /api/health`의 `road: true`는 키가 설정됐다는 뜻이며, 실제 이용 권한·쿼터·검색 성공 보장이 아닙니다.
- `GET /api/config`는 기존 SDK용 공개 JavaScript 키만 제공합니다. 업무도구함 REST 연동에서는 호출할 필요 없습니다.

## 오류 처리와 호출 제한

API 오류는 보통 `{ "code": "…", "error": "한국어 안내" }`입니다.
REST 키·환경변수 전체·상위 오류 원문을 반환하거나 검색어/주소를 서버 로그에 기록하지 않습니다.

| 코드 | HTTP | 화면 처리 |
|---|---|---|
| `BAD_SEARCH` / `BAD_POINTS` / `BAD_JSON` / `BAD_REQUEST` | 400 | 입력·요청 형식 확인 |
| `REQUEST_TOO_LARGE` | 413(본문) / 414(URL) | 요청 크기 줄이기 |
| `METHOD` | 405 | 검색은 GET, 거리표는 POST 사용 |
| `ORIGIN` / `PREFLIGHT` | 403 | 관리자에게 출처·허용 메서드/헤더 설정 확인 요청 |
| `NO_KEY` | 503 | 관리자에게 서버 설정 문의. 직원에게 REST 키 요구 금지 |
| `KEY_INVALID` / `KEY_FORBIDDEN` | 502 | 관리자에게 키/Local API 또는 길찾기 권한 확인 요청 |
| `QUOTA` | 429 | 카카오 상위 호출 제한 안내. 자동 재시도 금지 |
| `RATE_LIMIT` | 429 | 서버 분당 요청 제한. 잠시 후 사용자 재요청 |
| `DAILY_BUDGET` | 429 | 해당 검색/길찾기 외부 호출 상한. 관리자 확인 |
| `SEARCH_BUSY` | 429 | 동시 검색 처리 중. 잠시 후 사용자 재요청 |
| `TIMEOUT` | 504 | 응답 지연 안내. 자동 반복 요청 금지 |
| `NETWORK` / `UPSTREAM` / `BAD_RESPONSE` | 502 | 서버 연결/상위 응답 문제 안내 |
| `UNKNOWN` | 500 | 처리 실패 안내 후 관리자 문의 |

기존 `/api/config`·`/api/matrix`의 메서드 오류는 `error`만 반환할 수 있습니다.
클라이언트는 HTTP 상태와 `code` 유무를 함께 처리해야 합니다.
브라우저에서 응답 자체를 읽지 못하면 네트워크·CORS·서버 장애를 단정해서 구분하지 말고
“출장 서버에 연결하지 못했습니다. 인터넷 연결과 서버 주소를 확인해 주세요”로 안내합니다.

검색과 길찾기의 IP별 분당 요청 제한·외부 호출 상한은 별도입니다.
분당 제한은 서버에 들어온 요청을 세며, 동일 검색을 공유해도 요청 수에는 포함합니다.
외부 호출 상한은 실제 fetch 직전 동기적으로 예약·차감하여 동시 요청도 넘지 못하게 합니다.
성공·인증 실패·타임아웃·네트워크 실패 모두 호출 시도로 집계하고 돌려주지 않습니다.
동일 type/query/page/size의 **진행 중인** 검색은 외부 호출 1회를 공유하며, 완료 후 캐시는 남기지 않습니다.
길찾기도 성공한 행렬 요청 뒤에만 집계하던 방식을 고쳐 외부 호출마다 미리 차감합니다.
길찾기 중 하나가 실패하면 새 후속 작업은 멈추되 이미 시작한 호출은 종료·집계합니다.

상한은 **메모리 기반·프로세스별**이며 재시작 시 초기화되고 여러 인스턴스 사이에 공유되지 않습니다.
일일 상한은 한국시간 자정 기준이 아니라 프로세스 시작/마지막 초기화 후 약 24시간 창입니다.
카카오 공식 무료 한도와 같은 수치가 아니며 과금 방지를 보장하지 않습니다.
API 자체 집계 외에도 Render/기관 프록시 접근 로그에는 URL의 검색어가 남을 수 있으므로
운영자가 해당 로그 정책을 확인해야 합니다.

## 업무도구함에서 수정할 부분과 예제

API 기본 주소를 설정 한곳에서 관리하고, 배포된 Render HTTPS 출처를 입력합니다.
예시의 `https://your-service.onrender.com`은 실제 운영 주소로 바꿔야 합니다.
요청은 `file://` 기준 상대 경로가 아닌 **절대 URL**로 전송합니다.

```js
const TRIP_API_BASE = 'https://your-service.onrender.com';

async function tripRequest(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40000);
  try {
    const response = await fetch(new URL(path, TRIP_API_BASE), {
      ...options, credentials: 'omit', signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || '출장 서버 요청을 처리하지 못했습니다.');
      error.code = data.code || `HTTP_${response.status}`;
      throw error;
    }
    return data;
  } finally { clearTimeout(timer); }
}

// 검색 버튼에서 실행. 버튼 중복 클릭 방지와 AbortController/요청 순번으로
// 오래된 검색 응답이 최신 목록을 덮어쓰지 않도록 업무도구함 UI에서 처리합니다.
async function searchTripPlaces(type, query, page = 1) {
  return tripRequest('/api/search?' + new URLSearchParams({type, query, page}));
}
async function getTripRoadMatrix(selectedPoints) {
  const data = await tripRequest('/api/matrix', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({points: selectedPoints.map(({lat, lng}) => ({lat, lng}))})
  });
  if (!Array.isArray(data.missing) || data.missing.length ||
      !Array.isArray(data.matrix) || data.matrix.length !== selectedPoints.length ||
      data.matrix.some(row => !Array.isArray(row) || row.length !== selectedPoints.length ||
        row.some(cell => !cell || !Number.isFinite(cell.distance) || cell.distance < 0 ||
          !Number.isFinite(cell.duration) || cell.duration < 0))) {
    throw new Error('일부 구간의 도로거리·시간을 확인하지 못했습니다.');
  }
  return data; // 방향 유지, 내부 최적화 함수에 전달
}
```

예제의 예외는 출장 도구 UI에서 catch하고 안내합니다. 검색 목록에 문자열을 넣을 때
`textContent`를 사용하고 응답 문자열을 `innerHTML`로 실행하지 않습니다.
주소검색 ID가 `null`일 수 있으므로 중복 검사는 ID만으로 하지 말고 기존 좌표·주소 기준도 유지합니다.

업무도구함 담당자의 적용 목록:

1. 출장 도구를 열거나 사용자가 검색·도로거리 계산을 요청할 때만 서버에 연결합니다.
   전체 업무도구함 시작 시 반복 health 체크·백그라운드 검색을 추가하지 않습니다.
   다른 오프라인 도구를 쓰는 동안에는 서버를 호출하지 않습니다.
2. 출장 화면에 **“장소·주소 검색 및 자동차 도로거리 계산은 인터넷 연결 필요”**를 표시합니다.
   키 입력 UI는 만들지 않습니다. 출발지·최대 출장지·중복 검사·복귀 선택을 유지합니다.
3. **“출장 도구 사용 시 검색어·주소·좌표가 Render 서버와 카카오에 전송됩니다”**를 안내합니다.
   기존 “모든 자료가 외부로 전송되지 않는다” 문구를 실제 도구별 동작에 맞게 수정합니다.
4. CSP가 외부 fetch를 막는다면 기존 정책을 보존하고 `connect-src`에 해당 Render HTTPS 출처만 추가합니다.
   예: 기존 `connect-src 'self'` → `connect-src 'self' https://your-service.onrender.com`.
   서버가 카카오를 호출하므로 이 REST 연동만을 위해 브라우저에 카카오 SDK나 광범위한 `*`를 허용할 필요 없습니다.
5. 서버 연결 실패는 출장 도구 영역에만 표시합니다. 선택한 지점·다른 도구 자료를 지우거나
   업무도구함 전체를 사용할 수 없게 하지 않습니다. 무한 재시도·실패 시 자동 재호출은 하지 않습니다.
6. 오프라인에서는 이미 보유한 좌표를 사용한 직선거리 최적화·복귀 처리·복사·인쇄를 사용할 수 있습니다.
   검색·새 도로거리 조회·카카오맵 링크는 인터넷이 필요합니다. 도로거리 실패를 직선거리 결과로 위장하지 않습니다.

## 검증과 인계

```bash
npm install --no-save --package-lock=false playwright@1.56.1
npx playwright install chromium
node tests/verify.mjs
node tests/road.mjs
node tests/config.mjs
node --test tests/search.mjs
```

`tests/search.mjs`는 가짜 Local/길찾기 상위 서버와 실제 Node 서버를 실행합니다.
`tests/fixtures/toolbox-client.html`은 검색→결과 선택→거리표 요청만 수행하는 최소 브라우저 검증 파일입니다.
업무도구함 대체 제품이나 통합 완료 결과물이 아닙니다.
테스트의 장소·주소·좌표·REST 키는 Mock 데이터입니다. 실제 카카오 API를 호출하지 않습니다.
브라우저 CORS 검증 시 웹 보안을 끄거나 file URL을 HTTP로 바꾸어 대체하지 않습니다.

운영 배포 전 담당자는 실제 Render 설정을 검토하고, 별도 배포 승인 후 기존 사이트와
실제 업무도구함에서 최소한의 실제 검색·주소검색·도로거리 조회를 확인해야 합니다.
확인되지 않은 Render 배포나 운영 연동 성공을 이 변경으로 보장하지 않습니다.

2026-11-24 현재 변경의 실행 결과:

| 검사 | 결과 |
|---|---|
| 기존 직선거리·화면 `verify.mjs` | 122건 통과, 실패 0 |
| 기존 도로거리 `road.mjs` | 85건 통과, 실패 0 |
| 기존 공개 설정 `config.mjs` | 32건 통과 |
| 신규 `search.mjs` | 하위 시나리오 12개 및 상위 테스트 통과(node:test 총 13), 실패·취소·건너뜀 0 |

현재 클라우드는 Playwright 다운로드 호스트와 시스템 Chromium의 파일 접근에 제약이 있어,
저장소 밖에 npm 무결성 검증을 유지해 설치한 `@sparticuz/chromium@153.0.0`의 실행 파일을
Playwright 1.56.1 `executablePath`로 지정해 검증했습니다. 패키지의 추가 브라우저 옵션은
사용하지 않고 Playwright 기본 보안 설정을 유지했습니다. `file://`를 실제로 열고 서버가
수신한 Origin을 테스트 프로세스 IPC로 관찰했으며, `null`인 것을 확인했습니다.
외부 실행 보조 파일은 제품 의존성이 아니며 일반 개발 환경에서는 위 표준 명령을 사용합니다.
모든 API 결과는 Mock 검증입니다. 실제 Kakao 권한·호출·과금 조건, Render 운영 배포,
연결되지 않은 실제 업무도구함의 통합 동작은 검증하지 않았습니다.
