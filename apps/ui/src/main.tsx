import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { JoinPage } from "./pages/JoinPage";
import { SignInPage } from "./pages/SignInPage";
import { routeOf } from "./route";
import "./styles.css";

const route = routeOf(location.pathname);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {route.page === "join" ? <JoinPage code={route.code} /> : route.page === "sign-in" ? <SignInPage /> : <App />}
  </StrictMode>,
);
