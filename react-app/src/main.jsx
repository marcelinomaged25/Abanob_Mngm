import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
import "./theme.css";

class AppBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <main className="app-error-screen">
        <section className="app-error-card" role="alert">
          <span className="app-error-icon" aria-hidden="true">
            !
          </span>
          <p className="section-kicker">خطأ غير متوقع</p>
          <h1>حدث خطأ في عرض الصفحة</h1>
          <p className="app-error-message">
            {String(this.state.error?.message || "تعذر إكمال العملية. جرّب إعادة تحميل الصفحة.")}
          </p>
          <div className="app-error-actions">
            <button className="primary-button" type="button" onClick={() => window.location.reload()}>
              إعادة تحميل الصفحة
            </button>
            <a className="secondary-button" href="/">
              العودة إلى الصفحة الرئيسية
            </a>
          </div>
          <details className="app-error-details">
            <summary>تفاصيل تقنية</summary>
            <pre dir="ltr">
              {String(this.state.error?.stack || this.state.error?.message || "خطأ غير معروف")}
            </pre>
          </details>
        </section>
      </main>
    ) : (
      this.props.children
    );
  }
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppBoundary>
      <App />
    </AppBoundary>
  </React.StrictMode>,
);
