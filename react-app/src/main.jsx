import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

class AppBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() { return this.state.error ? <main style={{ padding: 32, color: "#172137", fontFamily: "Segoe UI, Tahoma, sans-serif" }}><h1>حدث خطأ في عرض الصفحة</h1><p>{this.state.error.message}</p></main> : this.props.children; }
}

createRoot(document.getElementById("root")).render(<React.StrictMode><AppBoundary><App /></AppBoundary></React.StrictMode>);
