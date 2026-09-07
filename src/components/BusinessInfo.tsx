import '../business-info.css';

export function BusinessInfo() {
  return <div className="business-info" aria-label="운영 사업자 정보">
    <dl>
      <div><dt>상호</dt><dd>소프트빌드</dd></div>
      <div><dt>대표자</dt><dd>이창렬</dd></div>
      <div><dt>사업자등록번호</dt><dd>236-57-00826</dd></div>
      <div><dt>업태</dt><dd>도매 및 소매업</dd></div>
      <div><dt>종목</dt><dd>전자상거래 소매업</dd></div>
    </dl>
    <small>© {new Date().getFullYear()} 소프트빌드. All rights reserved.</small>
  </div>;
}
