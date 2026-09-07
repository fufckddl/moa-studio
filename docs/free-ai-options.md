# 무료 공개형 AI 후보

확인일: 2026-09-06. 공식 자료만 조사했으며 가입, 키 발급, 서비스 연동, 모델 다운로드는 하지 않았다. 한국어 콘텐츠 품질은 실제로 비교하지 않았으므로 아래 적합성 판단은 문서에 나온 기능을 기준으로 한 추론이다.

## 앱에 연결할 수 있는 후보

| 후보 | 무료 범위와 비용 | 카드뉴스·게시글 작업에 쓸 수 있는 기능 | 데이터와 운영 조건 |
| --- | --- | --- | --- |
| **Gemini API / Google AI Studio** | 일부 모델에 무료 API 티어가 있다. 모델·계정별 호출 제한이 있고 무제한은 아니다. API 키가 필요하다. | 텍스트·사진 입력, JSON 구조화 출력을 지원하는 모델이 있어 이번 서비스의 우선 시험 후보. 한국어 품질은 실제 메뉴·사진으로 확인해야 한다. | 무료 서비스의 입력·응답은 제품 개선에 쓰일 수 있고 사람 검토 대상이 될 수 있다. 사진도 입력에 포함된다. 비공개 고객 사진이나 개인정보를 보내는 운영에는 무료 조건이 맞는지 별도 검토가 필요하다. [요금](https://ai.google.dev/gemini-api/docs/pricing), [한도](https://ai.google.dev/gemini-api/docs/rate-limits), [데이터 약관](https://ai.google.dev/gemini-api/terms) |
| **Cloudflare Workers AI** | 무료 범위와 모델별 과금 조건은 계정과 선택 모델 기준으로 확인해야 한다. 일부 모델은 유료 플랜이 필요하다. | 현재 Cloudflare Pages 배포와 함께 운영하기 편하다. 텍스트·이미지 모델과 OpenAI 호환 API가 있으며 JSON/사진 지원은 선택 모델별 확인이 필요하다. | Cloudflare는 동의 없이 고객 입력·출력을 모델 학습·서비스 개선에 쓰지 않는다고 설명한다. 모델 라이선스는 별도다. [요금](https://developers.cloudflare.com/workers-ai/platform/pricing/), [데이터 사용](https://developers.cloudflare.com/workers-ai/platform/data-usage/), [모델 목록](https://developers.cloudflare.com/workers-ai/models/) |
| **Groq** | Free 티어가 있으나 모델별 RPM/TPM/일일 제한이 있다. 정확한 계정 한도는 콘솔에서 확인한다. API 키가 필요하다. | 텍스트, structured outputs, vision 지원 모델이 있어 생성 속도와 한국어 JSON 결과를 시험할 후보. | 기본 데이터 보관과 예외, Zero Data Retention 설정을 확인해야 한다. 사용량 메타데이터는 별도다. [한도](https://console.groq.com/docs/rate-limits), [구조화 출력](https://console.groq.com/docs/structured-outputs), [사진 입력](https://console.groq.com/docs/vision), [데이터](https://console.groq.com/docs/your-data) |
| **Hugging Face Inference Providers** | Free 사용자 월 **$0.10** 크레딧(변경 가능). 작은 실험에 가깝고 지속적인 서비스 운영을 무료로 보장하지 않는다. | 여러 공급자·모델을 같은 방식으로 비교하기 좋다. 텍스트·이미지 지원은 모델/공급자별로 다르다. | 공급자별 데이터 보관·학습 정책을 따로 확인해야 한다. [요금과 크레딧](https://huggingface.co/docs/inference-providers/pricing), [지원 기능](https://huggingface.co/docs/inference-providers/index) |
| **Ollama + 로컬 공개 모델** | 로컬 실행에는 외부 API 호출료가 없다. 대신 실행 기기의 메모리·연산·전력 비용이 든다. | Qwen/Gemma 등 공개 모델 계열을 검토할 수 있다. 정확한 버전의 Ollama 지원, 한국어·사진·JSON 지원은 라이브러리와 모델 카드 확인 후 선택한다. 특정 최신 버전 지원은 이 조사에서 확정하지 않았다. | 로컬 전용으로 실행하면 데이터가 외부 AI 공급자로 나가지 않는다. 공개 서비스에서 쓰려면 항상 켜진 서버가 필요하고 현재 Pages/Supabase 함수 안에서 모델 자체를 실행할 수는 없다. 상업 이용은 모델별 라이선스를 확인한다. [Ollama](https://ollama.com/), [라이브러리](https://ollama.com/library), [로컬 전용 모드](https://docs.ollama.com/faq), [모델 가져오기](https://docs.ollama.com/import) |

## 무료 웹 사용과 API는 구분

Google AI Studio나 [Qwen Studio](https://chat.qwen.ai/)에서 무료로 대화할 수 있다는 사실이 앱에 붙이는 API까지 무제한 무료라는 뜻은 아니다. 웹에서 초안을 수동으로 만들고 복사하는 용도와, 모아 스튜디오가 버튼 한 번으로 자동 생성하는 API 연동은 다른 사용 방식이다.

## 이번 서비스에 대한 판단

- **우선 실험 후보: Gemini API.** 사진 맥락과 한국어 게시글, 일정의 JSON 출력을 한 번에 다루기 좋을 가능성이 있다. 무료 티어의 데이터 사용 조건 때문에 공개 가능한 샘플만으로 먼저 평가하는 편이 맞다.
- **현재 배포와 함께 검토할 후보: Cloudflare Workers AI.** 기존 Cloudflare 환경과 연결하기 편하지만, 무료 범위와 실제 호출 가능량은 선택 모델과 계정 상태를 기준으로 다시 확인해야 한다.
- **호출료를 없애고 로컬에서 쓰려는 경우: Ollama.** 장비가 켜져 있어야 하므로 공개 유료 서비스의 안정적인 운영비까지 없어지는 것은 아니다.

무료 공급자를 선택하더라도 호출 한도, 공급자 장애, 개인정보 처리, 한국어 결과 품질과 JSON 형식 검증이 필요하다. 이번에는 후보와 조건만 정리했으며 어떤 공급자도 활성화하지 않았다. 유료 Gemini의 제품 개선 사용 제외 조건은 무료 티어와 구분해야 한다. [Gemini 데이터 보관 설명](https://ai.google.dev/gemini-api/docs/zdr)

## 사진 편집 API 추가 확인 — 2026-09-06

지금 필요한 것은 사진을 이해해 글을 쓰는 모델이 아니라, 입력 사진과 지시문으로 수정된 사진을 반환하는 모델이다.

- 현재 운영 사진 편집 공급자는 무료 후보가 아니라 OpenAI Images API다. 실제 연결은 `gpt-image-2`, `1024x1024`, `medium`, JPEG 결과 1장으로 구성되어 있으며 세부 운영 경계는 `docs/cloudflare-photo-edit.md`에 기록한다.
- Cloudflare Workers AI는 배포 인프라와 가까운 후보로 남길 수 있지만, 특정 사진 편집 모델 추천은 현재 운영 경로에서 제거했다. 무료 범위는 계정과 모델별 조건을 다시 확인한 뒤 별도로 판단해야 한다.
- **Gemini 텍스트 모델의 무료 API와 이미지 편집 API는 다르다.** 현재 공식 요금표의 Gemini 2.5 Flash Image, 3.1 Flash Image, 3.1 Flash Lite Image는 Free Tier가 Not available이다. 사진 이해/문구 생성을 무료로 할 수 있다는 사실만으로 사진 수정도 무료라고 판단하면 안 된다. [요금](https://ai.google.dev/gemini-api/docs/pricing)
- Hugging Face 무료 사용자 크레딧은 월 $0.10(변경 가능)으로 시험용에 가깝다. [요금](https://huggingface.co/docs/inference-providers/pricing)

이 추가 확인에서도 계정 가입, 유료 전환, 토큰 생성, 모델 호출, 실제 서비스 연동은 하지 않았다.
