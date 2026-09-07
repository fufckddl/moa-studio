# 모아 스튜디오 배포 준비

현재 프로젝트는 단일 서버 Docker 배포 기준으로 준비되어 있습니다.

- `web`은 Node 22 서버를 실행하고 Vite `dist` 빌드를 서빙합니다. SQLite 데이터는 `moa_data` 볼륨에 저장됩니다.
- `caddy`는 HTTPS 인증서를 자동 발급하고 모든 요청을 `web:8791`로 전달합니다.
- 앱 컨테이너만 `.env.production`의 비공개 값을 읽습니다. Caddy는 공개 도메인 값인 `APP_DOMAIN`만 Compose 치환으로 받습니다.

## 1. `.env.production` 만들기

운영 서버에서 `deploy.env.example`을 복사해 `.env.production`을 만들고 값을 직접 채웁니다. 이 파일은 Git에 커밋하면 안 됩니다.

```bash
cp deploy.env.example .env.production
chmod 600 .env.production
```

```env
APP_DOMAIN=moa.example.com
PUBLIC_APP_URL=https://moa.example.com

# Toss Payments individual integration keys from the same real shop.
TOSS_CLIENT_KEY=
TOSS_SECRET_KEY=

# Keep these disabled until the real Toss Payments shop, live keys, HTTPS domain,
# paid entitlements, AI delivery, cancellation/refund policy, and customer support flow are ready.
TOSS_LIVE_ENABLED=0
PAID_FEATURES_READY=0
MOA_AI_READY=0

MOA_SECURE_COOKIES=1
```

`APP_DOMAIN`은 서버로 연결된 실제 도메인이어야 합니다. 이 값이 없으면 Compose가 시작 전에 실패하도록 설정했습니다.

## 2. 빌드와 실행

`compose.yaml`을 파싱할 때 `${APP_DOMAIN}`이 필요하므로 `--env-file .env.production`을 같이 넘깁니다.

```bash
docker compose --env-file .env.production up -d --build
```

컨테이너 상태와 로그를 확인합니다.

```bash
docker compose --env-file .env.production ps
docker compose --env-file .env.production logs -f web caddy
```

헬스 체크는 실제 도메인으로 확인합니다.

```bash
curl -fsS https://moa.example.com/api/health
```

정상 응답:

```json
{"ok":true}
```

## 3. 실제 토스 결제 전환

배포 준비와 점검 중에는 `TOSS_LIVE_ENABLED=0`으로 둡니다. 실제 결제를 받기 전에는 아래 조건을 확인한 뒤 전환합니다.

1. 실제 도메인이 HTTPS로 정상 접속되는지 확인합니다.
2. 토스페이먼츠 소프트빌드 상점의 라이브 `clientKey`와 `secretKey`를 `.env.production`에 넣습니다.
3. `PUBLIC_APP_URL=https://실제도메인`으로 맞춥니다.
4. 유료 권한, 기간 만료, 결제 내역, 고객 지원 흐름을 검증한 뒤 `PAID_FEATURES_READY=1`로 바꿉니다.
5. 유료 플랜에서 약속한 AI 제공 경로를 실제로 검증한 뒤 `MOA_AI_READY=1`로 바꿉니다.
6. `TOSS_LIVE_ENABLED=1`로 바꿉니다.
7. 앱을 다시 실행합니다.

```bash
docker compose --env-file .env.production up -d
```

라이브 결제에는 localhost나 HTTP 주소를 사용하지 않습니다.

라이브 결제 주문 조회와 멤버십 조회는 토스 결제 상태를 다시 확인합니다. 토스 상태가 취소 또는 부분 취소이면 로컬 주문 상태를 취소로 동기화하고 유료 권한에서 제외합니다. 웹훅은 토스 조회 API로 재확인한 상태만 반영하며, 웹훅 본문만으로 결제 완료 권한을 부여하지 않습니다.

## 4. SQLite 데이터와 백업

SQLite 데이터베이스는 Docker 볼륨 `moa_data`의 `/app/.data`에 저장됩니다.

실행 중인 DB 파일을 직접 복사하지 말고, 컨테이너 안에서 SQLite `VACUUM INTO` 스냅샷을 만든 뒤 서버의 백업 폴더로 꺼냅니다.

```bash
docker compose --env-file .env.production exec web node -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('/app/.data/moa-studio.sqlite'); db.exec(\"VACUUM INTO '/app/.data/moa-studio-backup.sqlite'\"); db.close();"
mkdir -p ~/moa-studio-backups
docker cp "$(docker compose --env-file .env.production ps -q web):/app/.data/moa-studio-backup.sqlite" ~/moa-studio-backups/moa-studio-$(date +%Y%m%d-%H%M%S).sqlite
```

복사 후 볼륨 안의 임시 백업 파일을 삭제합니다.

```bash
docker compose --env-file .env.production exec web rm -f /app/.data/moa-studio-backup.sqlite
```

## 5. 로컬 프로덕션 스모크 테스트

공개 도메인 없이 프로덕션 빌드만 확인할 때는 앱 컨테이너만 실행합니다. 기존 개발 API가 `8791`을 쓰고 있을 수 있으므로 호스트 포트는 `8792`를 사용합니다.

```bash
docker build -t moa-studio:local .
docker run --rm -p 127.0.0.1:8792:8791 \
  -e NODE_ENV=production \
  -e HOST=0.0.0.0 \
  -e PORT=8791 \
  -e PUBLIC_APP_URL=http://127.0.0.1:8792 \
  -e MOA_SECURE_COOKIES=0 \
  -e TOSS_LIVE_ENABLED=0 \
  moa-studio:local
```

그 다음 `http://127.0.0.1:8792`와 `http://127.0.0.1:8792/api/health`를 확인합니다.
