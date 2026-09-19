# AWS 배포 (CloudFormation)

Cloudflare Workers + D1로 운영되는 앱을 AWS에 그대로 띄우기 위한 **간단한 데모용 배포**입니다.
해커톤 정식 배포 경로는 여전히 `main` 머지 → Cloudflare Workers입니다. 이 디렉터리는 그 경로를
대체하지 않습니다.

## 구성

```
브라우저 ──HTTPS──▶ CloudFront (*.cloudfront.net, 무료 인증서)
                        │ HTTP
                        ▼
                  EC2 (퍼블릭 서브넷, Amazon Linux 2023)
                   └ systemd: node aws/server.mjs  (:80)
                   └ EBS gp3: /var/lib/campus/app.sqlite
```

- **컴퓨트**: EC2 1대. NAT Gateway가 없어도 퍼블릭 서브넷에서 Letsur·Naver·채널톡 API로 아웃바운드가 나갑니다.
- **DB**: D1 대신 `node:sqlite`. 앱의 SQL이 SQLite 전용(`INSERT OR IGNORE`, `json_valid`, D1 `batch`)이라
  쿼리를 한 줄도 고치지 않으려고 SQLite를 유지했습니다. `aws/server.mjs`가 D1과 같은 인터페이스를 제공합니다.
- **마이그레이션**: 부팅할 때 `cloudflare/migrations/`를 순서대로 적용하고 적용 이력을 `d1_migrations`
  테이블에 남깁니다. D1과 같은 방식이라 이미 적용된 파일은 다시 실행되지 않습니다.
- **크론**: Workers의 `scheduled()` 대신 인스턴스 안에서 60초 주기로 `expire` → `deliverPush` →
  `deliverChannelReplies`를 실행합니다.
- **시크릿**: SSM Parameter Store(SecureString)에 저장하고 부팅 시 `/etc/campus.env`로 내려받습니다.
  CloudFormation 템플릿과 UserData에는 비밀값이 들어가지 않습니다.

## 배포

```sh
cp aws/.env.aws.example aws/.env.aws   # 값 채우기 (커밋 금지)
./aws/deploy.sh
```

끝나면 CloudFront URL과 `/api/health`·`/api/ready` 결과를 출력합니다. 첫 배포는 5~10분 걸립니다.

환경 변수로 조정할 수 있습니다.

```sh
STACK_NAME=my-stack REGION=ap-northeast-2 INSTANCE_TYPE=t4g.small ./aws/deploy.sh
```

| 변수                   | 기본값              | 설명                      |
| ---------------------- | ------------------- | ------------------------- |
| `STACK_NAME`           | `skku-team6-campus` | CloudFormation 스택 이름  |
| `REGION`               | `ap-northeast-2`    | 배포 리전                 |
| `INSTANCE_TYPE`        | `t3.small`          | `t4g.*`는 Graviton(arm64) |
| `VOLUME_SIZE_GB`       | `20`                | 루트 EBS 크기             |
| `ENV_FILE`             | `aws/.env.aws`      | 없으면 `.dev.vars`로 폴백 |
| `VPC_ID` / `SUBNET_ID` | 기본 VPC 자동 탐지  | 직접 지정 가능            |

재배포는 같은 명령을 다시 실행하면 됩니다. 새 번들을 올리고 스택을 갱신합니다.

## 확인과 운영

```sh
aws ssm start-session --target <InstanceId> --region ap-northeast-2
sudo journalctl -u campus -f          # 애플리케이션 로그
sudo cat /var/log/campus-bootstrap.log # 부팅 스크립트 로그
sudo systemctl restart campus
```

정적 파일을 바꾼 뒤 CloudFront 캐시를 비우려면:

```sh
aws cloudfront create-invalidation --distribution-id <DistributionId> --paths '/*'
```

## 삭제

```sh
./aws/destroy.sh
```

스택, EC2, **EBS의 SQLite 데이터**, CloudFront, SSM 파라미터, 번들 버킷을 모두 지웁니다.

## 알아둘 점

- EC2 1대 구성이라 무중단 배포·자동 복구가 없습니다. 인스턴스를 stop/start하면 퍼블릭 DNS가 바뀌어
  CloudFront origin이 끊기므로, 그때는 스택을 다시 배포하세요.
- 데이터는 인스턴스의 EBS에만 있습니다. 스냅샷·백업이 설정되어 있지 않습니다.
- 보안 그룹의 80 포트가 0.0.0.0/0으로 열려 있어 origin에 직접 접근할 수 있습니다. 데모를 넘어설
  경우 CloudFront 관리형 프리픽스 리스트(`com.amazonaws.global.cloudfront.origin-facing`)로 제한하세요.
- 로컬 Cloudflare 개발 흐름(`corepack pnpm dev:cloudflare`)은 그대로 사용합니다.
