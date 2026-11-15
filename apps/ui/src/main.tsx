import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { JoinPage } from "./pages/JoinPage";
import { SignInPage } from "./pages/SignInPage";
import { routeOf } from "./route";
import { applyTheme } from "./theme/apply";
import { currentTheme } from "./theme/theme-store";
import "./styles.css";

const route = routeOf(location.pathname);

// Before the first render, on every route, so there is no flash of the wrong colours.
applyTheme(currentTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {route.page === "join" ? <JoinPage code={route.code} /> : route.page === "sign-in" ? <SignInPage /> : <App />}
  </StrictMode>,
);
