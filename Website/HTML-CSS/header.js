
 // Общая шапка сайта. Меняйте её только здесь, на всех страницах она обновится сама.
(function () {
    var html =
        '<header class="topbar">' +
            '<div class="left">' +
                '<div class="logo" aria-hidden="true">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
                        // Корона
                        '<path d="M7 8L5.5 3.5L9 6L12 2L15 6L18.5 3.5L17 8"/>' +
                        '<path d="M7 8H17L16 10H8Z"/>' +
                        // Щит
                        '<path d="M8 10L4 9.5V13C4 17.2 7.4 20 12 22C16.6 20 20 17.2 20 13V9.5L16 10"/>' +
                        // Внутренняя грань
                        '<path d="M7 11.5V13C7 15.8 9 17.6 12 19C15 17.6 17 15.8 17 13V11.5"/>' +
                    '</svg>' +
                '</div>' +
                '<a class="btn" href="main.html">Главное меню</a>' +
            '</div>' +
            '<a class="btn user" href="profile.html">' +
                '<b id="user-name"></b>' +
                '<small id="user-role"></small>' +
            '</a>' +
        '</header>';

    document.currentScript.insertAdjacentHTML("afterend", html);

    window.setHeaderUser = function (name, role) {
        document.getElementById("user-name").textContent = name;
        document.getElementById("user-role").textContent = role;
    };

    window.setHeaderUser("…", "…");

    // Настоящий пользователь с сервера
    fetch("/api/me")
        .then(function (r) {
            if (r.status === 401) {
                location.href = "/login.html";
                return null;
            }
            return r.ok ? r.json() : null;
        })
        .then(function (me) {
            if (me) {
                window.setHeaderUser(
                    me.name,
                    me.roles.length
                        ? (me.roles[0].label || me.roles[0].name)
                        : "Без роли"
                );
            }
        })
        .catch(function () {});
})();
