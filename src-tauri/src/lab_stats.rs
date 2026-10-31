//! Screen-share lab (dev-only): system load snapshot for the diagnostic journal
//! (public/js/screen-lab.js). JS polls `lab_sys_stats` once a second while a
//! journal is recording and writes the result next to the WebRTC metrics, so a
//! software encoder pegging the CPU is told apart from a network bottleneck.
//!
//! CPU percentages need two samples, so the `System` lives across calls; the
//! first call after start returns zeros (warm-up), which JS ignores.

use std::sync::Mutex;

use serde_json::{json, Value};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

static SYS: Mutex<Option<System>> = Mutex::new(None);

/// Our process plus its descendants (Windows: msedgewebview2.exe tree hangs
/// off void). macOS WebKit helpers are XPC services parented by launchd, so
/// they are counted separately by name (may include Safari's own helpers).
fn collect(sys: &System) -> Value {
    let me = Pid::from_u32(std::process::id());
    let procs = sys.processes();

    let mut tree: Vec<Pid> = vec![me];
    let mut i = 0;
    while i < tree.len() {
        let parent = tree[i];
        for (pid, p) in procs {
            if p.parent() == Some(parent) && !tree.contains(pid) {
                tree.push(*pid);
            }
        }
        i += 1;
    }

    let mut app_cpu = 0.0f32;
    let mut app_mem: u64 = 0;
    let mut app_procs: Vec<Value> = Vec::new();
    for pid in &tree {
        if let Some(p) = procs.get(pid) {
            app_cpu += p.cpu_usage();
            app_mem += p.memory();
            app_procs.push(json!({
                "name": p.name().to_string_lossy(),
                "cpu": round1(p.cpu_usage()),
                "memMB": p.memory() / 1_048_576,
            }));
        }
    }
    app_procs.sort_by(|a, b| {
        b["cpu"].as_f64().unwrap_or(0.0).partial_cmp(&a["cpu"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal)
    });
    app_procs.truncate(6);

    let mut webkit_cpu = 0.0f32;
    let mut webkit: Vec<Value> = Vec::new();
    if cfg!(target_os = "macos") {
        for p in procs.values() {
            let name = p.name().to_string_lossy();
            if name.starts_with("com.apple.WebKit") {
                webkit_cpu += p.cpu_usage();
                webkit.push(json!({ "name": name, "cpu": round1(p.cpu_usage()) }));
            }
        }
    }

    let cores: Vec<f32> = sys.cpus().iter().map(|c| round1(c.usage())).collect();
    let core_max = cores.iter().cloned().fold(0.0f32, f32::max);

    json!({
        "cpuTotal": round1(sys.global_cpu_usage()),
        "cpuCoreMax": core_max,
        "cores": cores,
        // Process CPU is per-core percent (200 = two full cores busy).
        "appCpu": round1(app_cpu),
        "appMemMB": app_mem / 1_048_576,
        "appProcs": app_procs,
        "webkitCpu": round1(webkit_cpu),
        "webkitProcs": webkit,
        "memUsedMB": sys.used_memory() / 1_048_576,
        "memTotalMB": sys.total_memory() / 1_048_576,
    })
}

fn round1(v: f32) -> f32 {
    (v * 10.0).round() / 10.0
}

/// macOS power/thermal state. Thermal: 0 nominal, 1 fair, 2 serious,
/// 3 critical (serious+ means the OS is throttling the CPU). Power source
/// comes from `pmset`, polled rarely (JS asks with power=true every ~10 s).
#[cfg(target_os = "macos")]
fn power_state(with_source: bool) -> Value {
    use objc2_foundation::NSProcessInfo;
    let info = NSProcessInfo::processInfo();
    let thermal = info.thermalState().0;
    let low_power = info.isLowPowerModeEnabled();
    let source = if with_source {
        std::process::Command::new("pmset")
            .args(["-g", "batt"])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().replace('\t', " "))
    } else {
        None
    };
    json!({ "thermal": thermal, "lowPower": low_power, "batt": source })
}

#[cfg(not(target_os = "macos"))]
fn power_state(_with_source: bool) -> Value {
    Value::Null
}

pub fn snapshot(power: bool) -> Result<Value, String> {
    let mut guard = match SYS.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    if guard.is_none() {
        *guard = Some(System::new().map_err(|e| e.to_string())?);
    }
    let Some(sys) = guard.as_mut() else {
        return Err("system unavailable".into());
    };
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cpu().with_memory(),
    );
    let mut out = collect(sys);
    out["power"] = power_state(power);
    Ok(out)
}

/// Drop the cached `System` when the journal stops (it holds the full
/// process table).
pub fn reset() {
    if let Ok(mut g) = SYS.lock() {
        *g = None;
    }
}
