import '../business-info.css';

export function BusinessInfo() {
  return <div className="business-info" aria-label="운영 사업자 정보">
    <dl>
      <div><dt>상호</dt><dd>소프트빌드</dd></div>
      <div><dt>대표자</dt><dd>이창렬</dd></div>
      <div><dt>사업자등록번호</dt><dd>236-57-00826</dd></div>
      <div><dt>통신판매업</dt><dd>2026-경기안성-0202</dd></div>
      <div><dt>업태</dt><dd>도매 및 소매업</dd></div>
      <div><dt>종목</dt><dd>전자상거래 소매업</dd></div>
      <div><dt>주소</dt><dd>경기도 안성시 남파로 130</dd></div>
      <div><dt>전화</dt><dd><a href="tel:010-8929-4943">010-8929-4943</a></dd></div>
      <div><dt>이메일</dt><dd><a href="mailto:dlckdfuf141@gmail.com">dlckdfuf141@gmail.com</a></dd></div>
    </dl>
    <nav aria-label="정책 페이지">
      <a href="/terms">이용약관</a>
      <a href="/privacy">개인정보 처리방침</a>
      <a href="/refund">환불 정책</a>
      <a href="/support">고객지원</a>
    </nav>
    <small>© {new Date().getFullYear()} 소프트빌드. All rights reserved.</small>
  </div>;
}
