export function AccountFooter() {
  return (
    <div className="accountFooter">
      <div className="accountAvatar" aria-hidden="true">
        <span>我</span>
      </div>
      <div className="accountMeta">
        <div className="accountName">未登录</div>
        <div className="accountEmail">请先登录（占位）</div>
      </div>
      <button className="btn btnIcon" type="button" title="账户/设置（占位）">
        设置
      </button>
    </div>
  );
}



