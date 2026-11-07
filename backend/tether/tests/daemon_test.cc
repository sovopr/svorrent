// No USB, network configuration, real sleeps, or elevated privileges are used.
// Include the daemon with a renamed entry point and provide a fake C ABI.
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static unsigned int fake_sleep(unsigned int);
static int fake_usleep(useconds_t);
#define sleep fake_sleep
#define usleep fake_usleep
#define main daemon_main
#include "../svorrent-tetherd.cc"
#undef main
#undef usleep
#undef sleep

enum Scenario {
    MANY_DEVICES, LIST_ERROR, NO_DEVICES, NOT_ROOT, TRANSIENT_SCAN_ERROR,
    FAILED_AND_DISCONNECTED, ONCE_FAILED, ONCE_DISCONNECTED, INTERRUPTED_START,
    RECONNECT, INTERRUPTED_SCAN, LEASE_DROPPED_REAPPLY
};
static Scenario scenario;
static int scans, status_reads, creates, destroys, ip_requests, sleeps;
static bool live_session;
struct tk_session {};
static tk_session fake_session;

static unsigned int fake_sleep(unsigned int) {
    // End persistent-mode tests deterministically and catch runaway loops.
    assert(++sleeps <= 3);
    if (sleeps == 3) raise(SIGTERM);
    return 0;
}

static int fake_usleep(useconds_t) {
    if (scenario == INTERRUPTED_START) raise(SIGTERM);
    return 0;
}

extern "C" {
void tk_version(tk_version_info_t* version) {
    *version = {};
    strcpy(version->text, "test stub");
}

tk_result_t tk_check_environment(tk_environment_t* environment) {
    *environment = {};
    environment->is_root = scenario != NOT_ROOT;
    return TK_OK;
}

tk_result_t tk_cleanup_orphan_interfaces(size_t* removed, tk_error_t*) {
    if (removed) *removed = 0;
    return TK_OK;
}

tk_result_t tk_net_query(const char* interface_name, tk_net_state_t* out_state, tk_error_t*) {
    assert(strcmp(interface_name, "feth0") == 0);
    *out_state = {};
    out_state->has_address = true;
    if (scenario == LEASE_DROPPED_REAPPLY && scans >= 3) {
        strcpy(out_state->address, "169.254.75.221");
    } else {
        strcpy(out_state->address, "10.78.7.114");
    }
    return TK_OK;
}

tk_result_t tk_list_devices(tk_device_info_t* devices, size_t capacity,
                            size_t* count, bool, tk_error_t* error) {
    ++scans;
    if (scenario == INTERRUPTED_SCAN) raise(SIGTERM);
    if (scenario == LIST_ERROR || (scenario == TRANSIENT_SCAN_ERROR && scans == 2)) {
        strcpy(error->message, "simulated USB enumeration failure");
        return TK_ERR_FAILED;
    }
    *count = scenario == MANY_DEVICES ? capacity + 5 : 1;
    if (scenario == NO_DEVICES ||
        ((scenario == FAILED_AND_DISCONNECTED || scenario == ONCE_DISCONNECTED) && scans > 1)) {
        *count = 0;
    }
    for (size_t i = 0; i < capacity && i < *count; ++i) {
        devices[i] = {};
        devices[i].vendor_id = 0x18d1;
        devices[i].product_id = 0x4ee4;
        devices[i].bus_number = 1;
        devices[i].device_address = 2;
        strcpy(devices[i].description, "test device");
    }
    return TK_OK;
}

void tk_session_config_init(tk_session_config_t* config) { *config = {}; }

tk_session_t* tk_session_create(const tk_session_config_t* config, tk_error_t*) {
    assert(!live_session);
    assert(config->vendor_id == 0x18d1 && config->product_id == 0x4ee4);
    assert(config->bus_number == 1 && config->device_address == 2);
    assert(config->adopt_device_mac);
    live_session = true;
    ++creates;
    return &fake_session;
}

tk_result_t tk_session_start(tk_session_t* session, tk_error_t*) {
    assert(session == &fake_session && live_session);
    return TK_OK;
}

tk_result_t tk_session_stop(tk_session_t* session) {
    assert(session == &fake_session && live_session);
    return TK_OK;
}

void tk_session_destroy(tk_session_t* session) {
    assert(session == &fake_session && live_session);
    // An enumeration error must never destroy an otherwise healthy session.
    if (scenario == TRANSIENT_SCAN_ERROR) assert(!g_running);
    live_session = false;
    ++destroys;
}

tk_result_t tk_session_status_get(tk_session_t* session, tk_session_status_t* status) {
    assert(session == &fake_session && live_session);
    ++status_reads;
    *status = {};
    status->run_state = TK_RUN_RUNNING;
    strcpy(status->system_interface, "feth0");
    if (((scenario == FAILED_AND_DISCONNECTED || scenario == ONCE_FAILED) && scans > 1) ||
        (scenario == RECONNECT && scans == 2)) {
        status->run_state = TK_RUN_FAILED;
        strcpy(status->fatal, "simulated session failure");
    }
    return TK_OK;
}

void tk_ip_config_init(tk_ip_config_t* config) { *config = {}; }

tk_result_t tk_net_apply(const char* interface_name, const tk_ip_config_t* config,
                         tk_error_t*) {
    assert(g_running);
    assert(strcmp(interface_name, "feth0") == 0);
    assert(config->mode == TK_IP_MODE_DHCP && !config->set_default_route);
    ++ip_requests;
    return TK_OK;
}
} // extern "C"

static void run(Scenario next, const char* option, int expected_result) {
    scenario = next;
    scans = status_reads = creates = destroys = ip_requests = sleeps = 0;
    live_session = false;
    g_running = 1;
    char program[] = "svorrent-tetherd-test";
    char argument[16] = {};
    if (option) snprintf(argument, sizeof(argument), "%s", option);
    char* args[] = {program, argument, nullptr};
    assert(daemon_main(option ? 2 : 1, args) == expected_result);
    assert(!live_session && creates == destroys);
}

int main() {
    run(MANY_DEVICES, "--list", 0); // ASan checks enumeration buffer bounds.
    assert(scans == 1 && creates == 0);
    run(LIST_ERROR, "--list", 1);
    run(NO_DEVICES, "--list", 0);
    run(NOT_ROOT, nullptr, 1);
    assert(scans == 0 && creates == 0);
    run(TRANSIENT_SCAN_ERROR, nullptr, 0);
    assert(scans == 3 && creates == 1 && status_reads == 3 && ip_requests == 1);
    run(FAILED_AND_DISCONNECTED, nullptr, 0);
    assert(creates == 1 && destroys == 1);
    run(ONCE_FAILED, "--once", 0);
    assert(scans == 2 && sleeps == 1 && creates == 1);
    run(ONCE_DISCONNECTED, "--once", 0);
    assert(scans == 2 && sleeps == 1 && creates == 1);
    run(INTERRUPTED_START, nullptr, 0);
    assert(creates == 1 && status_reads == 0 && ip_requests == 0);
    run(RECONNECT, nullptr, 0);
    assert(scans == 3 && creates == 2 && status_reads == 3 && ip_requests == 2);
    run(INTERRUPTED_SCAN, nullptr, 0);
    assert(scans == 1 && creates == 0 && ip_requests == 0);
    run(LEASE_DROPPED_REAPPLY, nullptr, 0);
    assert(scans == 3 && creates == 1 && ip_requests == 2);
    puts("All 12 native daemon regression scenarios passed.");
}
