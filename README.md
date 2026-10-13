# Inuchat — AI 롤플레잉 채팅 플랫폼

개인/지인용 AI 롤플레잉 채팅 플랫폼. OpenRouter API 키 하나를 입력해 사용하는 **BYOK** 방식이라 운영 비용이 거의 들지 않습니다.

- **프론트엔드**: Vite + React + TypeScript + Tailwind (모바일 우선 PWA)
- **백엔드**: Supabase (Auth · Postgres · Storage) — 무료 티어
- **AI 호출**: 브라우저에서 OpenRouter로 직접 호출 (키는 서버에 저장되지 않음)

---

## 핵심 개념

- **작품(Work)**: 제목·설명·썸네일 + 메인 프롬프트 + 키워드북. 시스템 프롬프트는 전역 공통(관리자 설정).
- **세션(채팅방)**: 작품을 실제로 플레이하는 공간. 세션마다 독립된 대화 기억·유저 노트·출력량 설정.
- **유저 노트**: 세션별 글자 수 제한 없는 메모. 측면 메뉴에서 언제든 편집하며, 프롬프트의 독립된 `User Notes` 영역에 주입됨.

---

## 처음 실행하기 (5단계)

### 1. 패키지 설치
```bash
npm install
```

### 2. Supabase 프로젝트 만들기
1. https://supabase.com 에서 무료 프로젝트 생성
2. **SQL Editor**에서 `supabase/migrations/0001_init.sql` 내용을 붙여넣고 실행 (테이블·보안 정책 생성)
3. **Storage**에서 `thumbnails` 라는 이름의 **public 버킷** 생성
4. **Authentication → Providers**에서 Google 로그인을 쓰려면 Google OAuth 설정 (이메일 로그인은 기본 활성화)

### 3. 환경변수 설정
`.env.example`을 복사해 `.env` 를 만들고 값을 채웁니다.
```bash
cp .env.example .env
```
```
VITE_SUPABASE_URL=https://xxxx.supabase.co       # Project Settings → API
VITE_SUPABASE_ANON_KEY=eyJhbGci...                # Project Settings → API (anon public)
VITE_ADMIN_EMAIL=your@email.com                   # 본인(관리자) 이메일
```

### 4. 개발 서버 실행
```bash
npm run dev
```
브라우저에서 안내되는 주소(기본 http://localhost:5173)로 접속.

### 5. 앱 안에서 API 키 입력
로그인 후 **설정 탭 → API 키**에 키를 입력하면 채팅이 동작합니다.
(키는 이 기기 브라우저에만 저장됩니다.)

> **OpenRouter API 전용**
> [openrouter.ai](https://openrouter.ai) 에서 키 하나를 발급하면 Claude·Gemini·GPT 등 모든 모델을 단일 키로 사용할 수 있습니다.
> 무료 모델도 제공되므로 처음 사용하기에 가장 편리합니다.

---

## 배포 (무료)

Vercel 또는 Cloudflare Pages에 정적 배포:
- 빌드 명령: `npm run build`
- 출력 디렉터리: `dist`
- 환경변수: 위 `.env` 의 세 값을 배포 플랫폼에 등록

```bash
npm run build   # dist/ 생성
```

---

## 구현 현황

### Phase 1 ✅
- Google · 이메일 로그인
- 작품 목록/상세, 작품 제작·편집(기본정보·메인 프롬프트·썸네일)
- 채팅 세션 생성, OpenRouter AI 연동, 메시지 영속화
- 세션 누적 토큰 표시
- 측면 메뉴: 유저 노트 편집, 출력량 조정
- 설정: API 키, 기본 출력량, 프로필

### Phase 2 ✅
- 키워드북 편집 + 활성화 엔진 (태그 UI)
- 페르소나 등록 및 세션별 선택
- 메시지 편집·삭제 (AI 메시지)
- 상단바 통합 검색 (작품·유저)
- 관리자용 전역 시스템 프롬프트 편집 화면
- AI·유저 메시지 마크다운 렌더링
- 채팅방 보관·삭제

### Phase 3 ✅
- 비회원 모드 (localStorage 기반 채팅)
- 작품 공개 범위 3단계 (전체공개 / 링크공개 / 비공개)
- 토큰 슬라이더 무제한 옵션
- 작품 즐겨찾기
- 유저 팔로우 / 팔로워
- 프로필 사진 · 소개
- 유저 페이지
- 개인용 최신 작품 목록

### 요약 메모리 불변 규칙
- AI 답변의 턴은 활성 대화의 사용자 턴 순서로 다시 계산하며 리롤은 같은 턴으로 취급한다.
- AI 요약 노트는 생성 기준 턴을 저장한다.
- 요약 노트를 반영한 모델 요청에는 요약 기준 턴 이전의 원문 메시지를 넣지 않고, 요약 노트와 기준 턴 이후 메시지만 넣는다.
- 과거 특정 턴을 기준으로 요약을 생성해도 같은 규칙을 적용한다.

---

## Gemini 명시적 캐시 (OpenRouter)

- 배포 전 `supabase/migrations/0036_manual_prompt_cache.sql`을 적용한다. 기존 채팅방은 기본 OFF이며, 기존 세션 RLS가 설정 저장에도 적용된다.
- 채팅방 사이드 메뉴의 요약 메모리 설정 바로 아래에서 ON/OFF 및 기준 턴을 저장한다. OFF 요청에는 `cache_control` 필드를 전혀 보내지 않는다. 제공업체의 자동 캐시를 끄는 기능은 아니다.
- 시스템 프롬프트까지만 또는 특정 완료 AI 답변까지 지정할 수 있다. 시스템에는 작품 설정, 페르소나, 유저 노트, 요약, 스토리 노트가 포함된다.
- 선택한 답변 ID를 고정하며 새 턴이 생겨도 경계를 이동하지 않는다. 요약·삭제·리롤로 대상이 실제 전송 문맥에서 빠지면 안내 후 해당 요청에서 명시적 경계를 생략한다. 분기 채팅방은 새 ID를 사용하므로 기본 OFF로 시작한다.
- `google/gemini-*` 모델에서만 콘텐츠 블록의 `cache_control: { type: "ephemeral" }`을 전송한다. 다른 모델, 게스트 채팅, 요약 생성에는 적용하지 않는다. 실제 지원 여부와 최소 토큰 수는 OpenRouter 제공 경로에 달려 있다.
- 명시적 모드에서 활성 키워드북은 현재 사용자 입력 앞에 붙인다. 캐시된 Gemini 시스템 지시문에 매 턴 바뀌는 키워드가 섞이지 않도록 하기 위함이다. OFF일 때는 기존 메시지 배치를 유지한다.
- 캐시 지정은 적중 보장이 아니다. 만료나 내용/경계 변경으로 새 쓰기 비용이 발생할 수 있다. 기존 캐시 읽기·쓰기 토큰 표시와 OpenRouter 사용 내역으로 실제 적용을 확인한다.
- `npm test`는 OFF 요청 형식, 경계 고정, 요약/삭제/리롤 대상 검증, 메시지 정규화 및 실제 어댑터의 HTTP 본문을 검증한다(외부 API는 모의 응답).

## 폴더 구조
```
src/
├── lib/
│   ├── supabase.ts        # Supabase 클라이언트
│   ├── apiKeys.ts         # API 키 localStorage 관리
│   ├── llm/               # OpenRouter 어댑터 (브라우저 직접 호출)
│   └── prompt/assemble.ts # 프롬프트 조립 단일 진입점
├── hooks/useAuth.tsx      # 인증 컨텍스트
├── components/            # Layout, SessionMenu 등
├── pages/                 # 각 탭/화면
└── types/db.ts            # DB 타입
supabase/migrations/0001_init.sql  # 스키마 + RLS
```
