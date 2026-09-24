import { Suspense, lazy } from "react";
import { Routes, Route } from "react-router-dom";
import LandingPage from "./pages/LandingPage.jsx";

const ToolPage = lazy(() => import("./pages/ToolPage.jsx"));
const LoginPage = lazy(() => import("./pages/LoginPage.jsx"));
const DashboardPage = lazy(() => import("./pages/DashboardPage.jsx"));

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route
        path="/tool"
        element={
          <Suspense fallback={null}>
            <ToolPage />
          </Suspense>
        }
      />
      <Route
        path="/login"
        element={
          <Suspense fallback={null}>
            <LoginPage />
          </Suspense>
        }
      />
      <Route
        path="/dashboard"
        element={
          <Suspense fallback={null}>
            <DashboardPage />
          </Suspense>
        }
      />
    </Routes>
  );
}
