# ChatForMe — AI 롤플레잉 채팅 플랫폼

개인/지인용 AI 롤플레잉 채팅 플랫폼. 각자 자신의 API 키(Claude / Gemini / GPT)를 입력해 사용하는 **BYOK** 방식이라 운영 비용이 거의 들지 않습니다.

- **프론트엔드**: Vite + React + TypeScript + Tailwind (모바일 우선 PWA)
- **백엔드**: Supabase (Auth · Postgres · Storage) — 무료 티어
- **AI 호출**: 브라우저에서 각 공급사로 직접 호출 (키는 서버로 전송되지 않음) — **OpenRouter 권장**

---

## 핵심 개념

- **작품(Work)**: 제목·설명·썸네일 + 메인 프롬프트 + 키워드북. 시스템 프롬프트는 전역 공통(관리자 설정).
- **세션(채팅방)**: 작품을 실제로 플레이하는 공간. 세션마다 독립된 대화 기억·유저 노트·출력량 설정.
- **유저 노트**: 세션별 ≤2000자 메모. 측면 메뉴에서 언제든 편집, 프롬프트에 주입됨.

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

> **권장: OpenRouter API 사용**
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
- 채팅 세션 생성, 3사 AI 연동, 메시지 영속화
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
- 작품 탭 랭킹/신작순/장르별 (일간·주간·월간 랭킹, 오늘의 인기 신작)

### 예정
- 요약 메모리 (긴 대화 자동 압축) — 프롬프트 조립부(`src/lib/prompt/assemble.ts`)와 DB 자리는 이미 확보
- OpenRouter 전용 어댑터

---

## 폴더 구조
```
src/
├── lib/
│   ├── supabase.ts        # Supabase 클라이언트
│   ├── apiKeys.ts         # API 키 localStorage 관리
│   ├── llm/               # Claude/Gemini/OpenAI 어댑터 (브라우저 직접 호출)
│   └── prompt/assemble.ts # 프롬프트 조립 단일 진입점
├── hooks/useAuth.tsx      # 인증 컨텍스트
├── components/            # Layout, SessionMenu 등
├── pages/                 # 각 탭/화면
└── types/db.ts            # DB 타입
supabase/migrations/0001_init.sql  # 스키마 + RLS
```
