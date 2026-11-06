#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>

#ifdef _MSC_VER
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "shell32.lib")
#endif

static bool is_server_listening(void) {
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return false;

    SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET) {
        WSACleanup();
        return false;
    }

    u_long mode = 1;
    ioctlsocket(sock, FIONBIO, &mode);

    struct sockaddr_in addr;
    ZeroMemory(&addr, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(3001);
    addr.sin_addr.s_addr = inet_addr("127.0.0.1");

    int result = connect(sock, (struct sockaddr*)&addr, sizeof(addr));
    bool connected = result == 0;
    int error = connected ? 0 : WSAGetLastError();
    if (!connected && (error == WSAEWOULDBLOCK || error == WSAEINPROGRESS || error == WSAEALREADY)) {
        fd_set writeSet;
        FD_ZERO(&writeSet);
        FD_SET(sock, &writeSet);

        struct timeval tv;
        tv.tv_sec = 0;
        tv.tv_usec = 300000;

        if (select(0, NULL, &writeSet, NULL, &tv) > 0) {
            int socketError = 0;
            int size = sizeof(socketError);
            connected = getsockopt(sock, SOL_SOCKET, SO_ERROR, (char*)&socketError, &size) == 0 && socketError == 0;
        }
    }

    closesocket(sock);
    WSACleanup();
    return connected;
}

static bool file_exists(const wchar_t* path) {
    DWORD attrs = GetFileAttributesW(path);
    return (attrs != INVALID_FILE_ATTRIBUTES && !(attrs & FILE_ATTRIBUTE_DIRECTORY));
}

static bool find_node(const wchar_t* appDir, wchar_t* outNode, size_t maxLen) {
    wchar_t candidate[MAX_PATH];

    // 1. Check in appDir\node.exe
    swprintf(candidate, MAX_PATH, L"%ls\\node.exe", appDir);
    if (file_exists(candidate)) {
        wcsncpy(outNode, candidate, maxLen);
        return true;
    }

    // 2. Check in appDir\node\node.exe
    swprintf(candidate, MAX_PATH, L"%ls\\node\\node.exe", appDir);
    if (file_exists(candidate)) {
        wcsncpy(outNode, candidate, maxLen);
        return true;
    }

    // 3. Search PATH
    DWORD found = SearchPathW(NULL, L"node.exe", NULL, MAX_PATH, candidate, NULL);
    if (found > 0 && found < MAX_PATH && file_exists(candidate)) {
        wcsncpy(outNode, candidate, maxLen);
        return true;
    }

    // 4. Common standard install locations
    const wchar_t* common[] = {
        L"C:\\Program Files\\nodejs\\node.exe",
        L"C:\\Program Files (x86)\\nodejs\\node.exe"
    };
    for (int i = 0; i < 2; i++) {
        if (file_exists(common[i])) {
            wcsncpy(outNode, common[i], maxLen);
            return true;
        }
    }

    // 5. LocalAppData / AppData
    wchar_t envBuf[MAX_PATH];
    if (GetEnvironmentVariableW(L"LOCALAPPDATA", envBuf, MAX_PATH) > 0) {
        swprintf(candidate, MAX_PATH, L"%ls\\Programs\\nodejs\\node.exe", envBuf);
        if (file_exists(candidate)) {
            wcsncpy(outNode, candidate, maxLen);
            return true;
        }
    }
    if (GetEnvironmentVariableW(L"APPDATA", envBuf, MAX_PATH) > 0) {
        swprintf(candidate, MAX_PATH, L"%ls\\nvm\\current\\node.exe", envBuf);
        if (file_exists(candidate)) {
            wcsncpy(outNode, candidate, maxLen);
            return true;
        }
    }

    return false;
}

static bool is_backend_outdated(const wchar_t* exePath) {
    if (!is_server_listening()) return false;

    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return false;

    SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET) {
        WSACleanup();
        return false;
    }

    struct sockaddr_in addr;
    ZeroMemory(&addr, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(3001);
    addr.sin_addr.s_addr = inet_addr("127.0.0.1");

    if (connect(sock, (struct sockaddr*)&addr, sizeof(addr)) != 0) {
        closesocket(sock);
        WSACleanup();
        return false;
    }

    DWORD timeout = 1000;
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (const char*)&timeout, sizeof(timeout));
    setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, (const char*)&timeout, sizeof(timeout));

    const char* req = "GET /api/updater/status HTTP/1.0\r\nHost: 127.0.0.1:3001\r\nConnection: close\r\n\r\n";
    send(sock, req, (int)strlen(req), 0);

    char resp[4096];
    ZeroMemory(resp, sizeof(resp));
    int bytes = recv(sock, resp, sizeof(resp) - 1, 0);
    closesocket(sock);
    WSACleanup();

    if (bytes <= 0 || strstr(resp, "\"currentVersion\"") == NULL) {
        return true;
    }

    wchar_t infoPath[MAX_PATH];
    swprintf(infoPath, MAX_PATH, L"%ls\\backend\\build-info.json", exePath);
    FILE* f = _wfopen(infoPath, L"rb");
    if (f) {
        char buf[512];
        ZeroMemory(buf, sizeof(buf));
        size_t r = fread(buf, 1, sizeof(buf) - 1, f);
        fclose(f);
        if (r > 0) {
            char* commitPos = strstr(buf, "\"commit\":");
            if (commitPos) {
                char* q1 = strchr(commitPos, '"');
                if (q1) {
                    q1 = strchr(q1 + 1, '"');
                    if (q1) {
                        char* q2 = strchr(q1 + 1, '"');
                        if (q2) {
                            char* q3 = strchr(q2 + 1, '"');
                            if (q3 && (q3 - q2 - 1) == 40) {
                                char commitSha[41];
                                memcpy(commitSha, q2 + 1, 40);
                                commitSha[40] = '\0';
                                if (strstr(resp, commitSha) == NULL) {
                                    return true;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    return false;
}

static void kill_stale_backend(void) {
    _wsystem(L"cmd.exe /c \"for /f \\\"tokens=5\\\" %a in ('netstat -aon ^| findstr :3001 ^| findstr LISTENING') do taskkill /F /PID %a >nul 2>&1\"");
    Sleep(500);
}

int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, LPSTR lpCmdLine, int nCmdShow) {
    (void)hInstance;
    (void)hPrevInstance;
    (void)lpCmdLine;
    (void)nCmdShow;

    wchar_t exePath[MAX_PATH];
    GetModuleFileNameW(NULL, exePath, MAX_PATH);
    wchar_t* lastSlash = wcsrchr(exePath, L'\\');
    if (lastSlash) *lastSlash = L'\0';

    if (is_server_listening()) {
        if (is_backend_outdated(exePath)) {
            kill_stale_backend();
        } else {
            ShellExecuteW(NULL, L"open", L"http://localhost:3001", NULL, NULL, SW_SHOWNORMAL);
            return 0;
        }
    }

    wchar_t nodePath[MAX_PATH];
    if (!find_node(exePath, nodePath, MAX_PATH)) {
        int res = MessageBoxW(
            NULL,
            L"Svorrent requires Node.js (v18+) to run.\n\nWould you like to open nodejs.org to download Node.js now?",
            L"Svorrent — Node.js Required",
            MB_ICONINFORMATION | MB_YESNO | MB_DEFBUTTON1
        );
        if (res == IDYES) {
            ShellExecuteW(NULL, L"open", L"https://nodejs.org", NULL, NULL, SW_SHOWNORMAL);
        }
        return 1;
    }

    wchar_t backendDir[MAX_PATH];
    swprintf(backendDir, MAX_PATH, L"%ls\\backend", exePath);

    wchar_t serverJs[MAX_PATH];
    swprintf(serverJs, MAX_PATH, L"%ls\\server.js", backendDir);
    if (!file_exists(serverJs)) {
        MessageBoxW(NULL, L"Svorrent backend\\server.js is missing from the installation.", L"Svorrent Error", MB_ICONERROR | MB_OK);
        return 1;
    }

    wchar_t cmdLine[1024];
    swprintf(cmdLine, 1024, L"\"%ls\" --openssl-legacy-provider server.js", nodePath);

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    ZeroMemory(&pi, sizeof(pi));

    BOOL success = CreateProcessW(
        nodePath,
        cmdLine,
        NULL,
        NULL,
        FALSE,
        CREATE_NO_WINDOW | DETACHED_PROCESS,
        NULL,
        backendDir,
        &si,
        &pi
    );

    if (!success) {
        DWORD error = GetLastError();
        wchar_t message[256];
        swprintf(message, 256, L"Failed to launch Svorrent background server (Windows error %lu).", error);
        MessageBoxW(NULL, message, L"Svorrent Error", MB_ICONERROR | MB_OK);
        return 1;
    }

    CloseHandle(pi.hThread);

    bool ready = false;
    // First launch can take much longer than six seconds while Node loads dependencies.
    for (int i = 0; i < 300; i++) {
        if (WaitForSingleObject(pi.hProcess, 300) == WAIT_OBJECT_0) break;
        if (is_server_listening()) {
            ready = true;
            break;
        }
    }
    CloseHandle(pi.hProcess);

    if (!ready) {
        MessageBoxW(NULL, L"Svorrent could not start its local server. Check that port 3001 is free and Node.js is installed, then try again.", L"Svorrent Startup Error", MB_ICONERROR | MB_OK);
        return 1;
    }

    ShellExecuteW(NULL, L"open", L"http://localhost:3001", NULL, NULL, SW_SHOWNORMAL);
    return 0;
}
