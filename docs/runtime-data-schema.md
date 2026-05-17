# Runtime Data Schema

## 목적

`getAnonymousKey()`가 반환하는 `hash`를 기준으로 비게임 미니앱 사용자를 식별하고,
아래 운영 기능을 안정적으로 저장하기 위한 최소 스키마다.

- 사용자 상태 저장
- 추천 기록 저장
- 유저별 일일 추천 3회 제한
- 저장한 코스 관리
- 추후 Google 보강 캐시 영속화 확장

토스 문서 기준으로 `hash`는 미니앱별 고유 식별자이며, 인증 토큰이 아니라 내부 식별용 키로만 사용한다.

## 사용자 식별 원칙

- 클라이언트는 `getAnonymousKey()` 호출 결과의 `hash`를 서버로 전달한다.
- 서버는 이 값을 `anonymous_user_key`로 저장한다.
- 이 값은 로그인 정보가 아니므로 권한 검증 토큰처럼 쓰지 않는다.
- 추천 제한, 추천 기록, 저장 코스의 소유자 식별 용도로만 사용한다.

## 권장 테이블

### `users`

유저 기본 엔티티.

| column | type | note |
| --- | --- | --- |
| `id` | text | 내부 PK (`uuid` 권장) |
| `anonymous_user_key` | text | 토스 `getAnonymousKey().hash`, unique |
| `app_category` | text | 현재는 `non_game` 고정 가능 |
| `created_at` | datetime | 최초 생성 시각 |
| `last_seen_at` | datetime | 마지막 추천/접속 시각 |

인덱스:

- unique(`anonymous_user_key`)

### `user_daily_usage`

유저별 일일 추천 횟수 제한.

| column | type | note |
| --- | --- | --- |
| `id` | text | 내부 PK |
| `user_id` | text | `users.id` FK |
| `usage_date` | text | `YYYY-MM-DD`, KST 기준 |
| `recommend_count` | integer | 해당 날짜 추천 호출 누적 |
| `last_recommend_at` | datetime | 마지막 추천 시각 |
| `created_at` | datetime | 생성 시각 |
| `updated_at` | datetime | 수정 시각 |

인덱스:

- unique(`user_id`, `usage_date`)

### `recommendation_requests`

추천 요청 자체의 로그. 재현과 비용 분석용.

| column | type | note |
| --- | --- | --- |
| `id` | text | 내부 PK |
| `user_id` | text | `users.id` FK |
| `requested_at` | datetime | 추천 요청 시각 |
| `lat` | real | 요청 좌표 |
| `lng` | real | 요청 좌표 |
| `categories_json` | text | 선택 카테고리 배열 JSON |
| `duration` | text | `1h`, `2h`, `3h`, `4h+` |
| `environment` | text | `실내`, `야외`, `상관없음` |
| `transport` | text | `도보`, `대중교통`, `차량` |
| `companion` | text | 동반자 |
| `weather_aware` | integer | 0/1 |
| `require_parking` | integer | 0/1 |
| `require_restroom` | integer | 0/1 |
| `require_child_facilities` | integer | 0/1 |
| `result_course_count` | integer | 반환 코스 개수 |
| `result_place_count` | integer | 반환 place 개수 |
| `remaining_today` | integer | 응답 시점 남은 횟수 |

인덱스:

- index(`user_id`, `requested_at`)

### `recommendation_courses`

한 추천 요청에서 실제로 내려준 코스 스냅샷.

| column | type | note |
| --- | --- | --- |
| `id` | text | 내부 PK |
| `request_id` | text | `recommendation_requests.id` FK |
| `course_order` | integer | 0-based or 1-based |
| `title` | text | 코스 제목 |
| `duration_minutes` | integer | 총 소요 시간 |
| `tags_json` | text | 태그 배열 JSON |
| `weather_hint` | text | 날씨 힌트 |
| `is_popular` | integer | 0/1 |
| `ai_reason` | text | AI 요약 |
| `places_json` | text | 코스 내 place 스냅샷 배열 JSON |
| `created_at` | datetime | 생성 시각 |

인덱스:

- index(`request_id`, `course_order`)

### `saved_courses`

사용자가 저장한 코스.

| column | type | note |
| --- | --- | --- |
| `id` | text | 내부 PK |
| `user_id` | text | `users.id` FK |
| `source_request_id` | text | 원본 추천 요청 FK, nullable |
| `course_title` | text | 저장 시점 제목 |
| `duration_minutes` | integer | 저장 시점 소요시간 |
| `tags_json` | text | 태그 배열 JSON |
| `places_json` | text | 장소 스냅샷 배열 JSON |
| `saved_at` | datetime | 저장 시각 |

인덱스:

- index(`user_id`, `saved_at`)

### `google_place_cache`

운영에서 Google 보강 영속 캐시를 붙일 때 쓰는 테이블.

| column | type | note |
| --- | --- | --- |
| `cache_key` | text | `name|address|lat,lng` |
| `status` | text | `hit`, `miss`, `invalid` |
| `place_id` | text | 검증된 Google place id, nullable |
| `payload_json` | text | 보강 결과 JSON |
| `expires_at` | datetime | TTL 만료 시각 |
| `updated_at` | datetime | 갱신 시각 |

인덱스:

- primary key(`cache_key`)
- index(`expires_at`)

### `google_place_failure_cache`

못 찾은 장소 재시도 방지용 캐시.

| column | type | note |
| --- | --- | --- |
| `cache_key` | text | `name|address|lat,lng|category` |
| `failure_reason` | text | `no_candidates`, `score_below_threshold`, `invalid_identity` 등 |
| `expires_at` | datetime | 30분~6시간 TTL 권장 |
| `updated_at` | datetime | 갱신 시각 |

인덱스:

- primary key(`cache_key`)
- index(`expires_at`)

## 추천 3회 제한 규칙

- 기준 키: `users.anonymous_user_key`
- 기준 날짜: KST `YYYY-MM-DD`
- 카운트 증가 시점: `/api/recommend` 정상 추천 응답 직전 또는 추천 계산 시작 직후 중 하나로 고정
- 권장값:
  - 운영: 하루 3회
  - 개발: 제한 없음 또는 별도 플래그

## 현재 코드와의 연결 포인트

- 프론트:
  - `getAnonymousKey().hash`를 추천 API 요청에 포함
  - 헤더 `X-Anonymous-User-Key` 또는 query/body 필드로 전달
- 백엔드:
  - `ipRateLimit` 대신 `anonymous_user_key` 기반 제한으로 이동
  - 추천 성공 시 `user_daily_usage` 증가
  - 추천 응답 저장 시 `recommendation_requests`, `recommendation_courses` 기록

## 최소 도입 순서

1. `users`
2. `user_daily_usage`
3. `recommendation_requests`
4. `saved_courses`
5. `google_place_failure_cache`
6. `google_place_cache`
