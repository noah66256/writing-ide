import { Link, useLocation } from "react-router-dom";
import { getAccessToken, clearAccessToken } from "../api/client.ts";

export default function NavBar() {
  const loc = useLocation();
  const isLanding = loc.pathname === "/";
  const token = getAccessToken();

  return (
    <nav className="nav-blur fixed top-0 left-0 right-0 z-50">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5 font-bold text-[17px] text-gray-900 no-underline">
          <img src="/icon.png" className="w-7 h-7 rounded-lg" alt="logo" />
          <span>Oh My Crab</span>
        </Link>

        {isLanding && (
          <div className="hidden md:flex items-center gap-7 text-[14px] text-gray-600">
            <a href="#features" className="hover:text-gray-900 transition-colors no-underline">功能</a>
            <a href="#modes" className="hover:text-gray-900 transition-colors no-underline">模式</a>
            <a href="#how" className="hover:text-gray-900 transition-colors no-underline">工作原理</a>
            <a href="#pricing" className="hover:text-gray-900 transition-colors no-underline">定价</a>
          </div>
        )}

        <div className="flex items-center gap-3">
          {token ? (
            <>
              <Link to="/dashboard" className="btn-outline text-sm py-2 px-4">
                <i className="fa fa-th-large" /> 控制台
              </Link>
              <button
                className="text-sm text-gray-400 hover:text-gray-700 transition-colors"
                onClick={() => { clearAccessToken(); window.location.href = "/"; }}
              >
                退出
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="text-sm text-gray-600 hover:text-gray-900 transition-colors no-underline">
                登录
              </Link>
              <a href="#download" className="btn-brand text-sm py-2 px-5">
                <i className="fa fa-download" /> 免费下载
              </a>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
