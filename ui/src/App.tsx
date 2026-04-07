import React from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { ToastProvider } from "./components/Toast.tsx";
import ApiKeys from "./tabs/ApiKeys.tsx";
import Configuration from "./tabs/Configuration.tsx";
import Dashboard from "./tabs/Dashboard.tsx";
import Intelligence from "./tabs/Intelligence.tsx";
import Logs from "./tabs/Logs.tsx";
import Run from "./tabs/Run.tsx";
import Telemetry from "./tabs/Telemetry.tsx";
import Tournament from "./tabs/Tournament.tsx";

const TABS = [
  { to: "/",              label: "Dashboard"     },
  { to: "/run",           label: "Run"           },
  { to: "/configuration", label: "Configuration" },
  { to: "/api-keys",      label: "API Keys"      },
  { to: "/logs",          label: "Logs"          },
  { to: "/telemetry",     label: "Telemetry"     },
  { to: "/intelligence",  label: "Intelligence"  },
  { to: "/tournament",    label: "Tournament"    },
];

export default function App() {
  return (
    <ToastProvider>
      <div className="app-shell">
        <header className="app-header">
          <span className="app-logo">or<span>ager</span></span>
          <nav className="tab-nav">
            {TABS.map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                className={({ isActive }) =>
                  "tab-link" + (isActive ? " active" : "")
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
        </header>
        <main className="app-content">
          <Routes>
            <Route path="/"              element={<Dashboard />} />
            <Route path="/run"           element={<Run />} />
            <Route path="/configuration" element={<Configuration />} />
            <Route path="/api-keys"      element={<ApiKeys />} />
            <Route path="/logs"          element={<Logs />} />
            <Route path="/telemetry"     element={<Telemetry />} />
            <Route path="/intelligence"  element={<Intelligence />} />
            <Route path="/tournament"    element={<Tournament />} />
          </Routes>
        </main>
      </div>
    </ToastProvider>
  );
}
