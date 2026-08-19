(() => {

    /* ==============================
       STYLE
    ============================== */

    const style =
        document.createElement("style");


    style.textContent = `

        #amr29-goal {

            width: 100%;
            max-width: 500px;

            margin:
                0 auto 22px;

            padding:
                20px;

            border-radius:
                20px;

            color:
                white;

            background:
                linear-gradient(
                    145deg,
                    rgba(30,30,39,.96),
                    rgba(18,18,24,.96)
                );

            border:
                1px solid
                rgba(255,255,255,.08);

            box-shadow:
                0 20px 60px
                rgba(0,0,0,.32);

            font-family:
                "Segoe UI",
                "Noto Sans Thai",
                Arial,
                sans-serif;

            transition:
                transform .25s ease,
                border-color .25s ease,
                box-shadow .25s ease;
        }


        #amr29-goal:hover {

            transform:
                translateY(-3px);

            border-color:
                rgba(255,91,127,.28);

            box-shadow:
                0 24px 70px
                rgba(0,0,0,.40),
                0 0 30px
                rgba(255,91,127,.06);
        }


        .amr29-goal-top {

            display:
                flex;

            justify-content:
                space-between;

            align-items:
                center;

            gap:
                12px;
        }


        .amr29-goal-label {

            color:
                #777783;

            font-size:
                9px;

            font-weight:
                900;

            letter-spacing:
                1.8px;
        }


        #amr29-goal-title {

            margin-top:
                4px;

            font-size:
                18px;

            font-weight:
                850;
        }


        #amr29-goal-percent {

            padding:
                6px 10px;

            border-radius:
                999px;

            background:
                rgba(255,91,127,.10);

            color:
                #ff7895;

            font-size:
                12px;

            font-weight:
                900;

            white-space:
                nowrap;
        }


        .amr29-goal-money {

            margin-top:
                18px;

            font-size:
                30px;

            font-weight:
                900;
        }


        .amr29-goal-muted {

            color:
                #8d8d99;

            font-size:
                14px;

            font-weight:
                600;
        }


        .amr29-goal-track {

            position:
                relative;

            height:
                10px;

            margin-top:
                14px;

            border-radius:
                999px;

            background:
                rgba(255,255,255,.06);
        }


        #amr29-goal-bar {

            width:
                0%;

            height:
                100%;

            overflow:
                hidden;

            border-radius:
                inherit;

            background:
                linear-gradient(
                    90deg,
                    #ff5279,
                    #ff9db8
                );

            box-shadow:
                0 0 14px
                rgba(255,91,127,.30);

            transition:
                width .85s
                cubic-bezier(.16,1,.3,1);
        }


        #amr29-goal-spark {

            position:
                absolute;

            top:
                50%;

            left:
                0%;

            width:
                11px;

            height:
                11px;

            border-radius:
                50%;

            transform:
                translate(-50%, -50%);

            background:
                white;

            box-shadow:
                0 0 9px white,
                0 0 20px #ff7895;

            opacity:
                0;

            transition:
                left .85s
                cubic-bezier(.16,1,.3,1),
                opacity .2s ease;
        }


        #amr29-goal-note {

            margin-top:
                11px;

            color:
                #888894;

            font-size:
                11px;
        }


        /* ==============================
           COMPLETE
        ============================== */

        #amr29-goal.complete {

            border-color:
                rgba(255,205,80,.30);

            box-shadow:
                0 24px 70px
                rgba(0,0,0,.40),
                0 0 35px
                rgba(255,205,80,.08);
        }


        #amr29-goal.complete
        #amr29-goal-percent {

            color:
                #ffd86a;

            background:
                rgba(255,205,80,.10);
        }


        #amr29-goal.complete
        #amr29-goal-bar {

            background:
                linear-gradient(
                    90deg,
                    #ffb73e,
                    #ffe875
                );

            box-shadow:
                0 0 16px
                rgba(255,210,80,.35);
        }


        #amr29-goal.complete
        #amr29-goal-spark {

            box-shadow:
                0 0 10px white,
                0 0 24px #ffe875;
        }


        /* ==============================
           LOADING
        ============================== */

        #amr29-goal.loading {

            opacity:
                .65;

            pointer-events:
                none;
        }


        /* ==============================
           MOBILE
        ============================== */

        @media
        (max-width: 540px) {

            #amr29-goal {

                padding:
                    17px;

                border-radius:
                    17px;
            }


            #amr29-goal-title {

                font-size:
                    16px;
            }


            .amr29-goal-money {

                font-size:
                    26px;
            }
        }

    `;


    document.head.appendChild(
        style
    );


    /* ==============================
       CREATE WIDGET
    ============================== */

    const widget =
        document.createElement(
            "section"
        );


    widget.id =
        "amr29-goal";


    widget.classList.add(
        "loading"
    );


    widget.innerHTML = `

        <div class="amr29-goal-top">

            <div>

                <div
                    class="amr29-goal-label"
                >
                    DONATION GOAL
                </div>

                <div
                    id="amr29-goal-title"
                >
                    เป้าหมายสนับสนุน
                </div>

            </div>


            <div
                id="amr29-goal-percent"
            >
                0%
            </div>

        </div>


        <div
            class="amr29-goal-money"
        >

            <span
                id="amr29-goal-current"
            >
                0
            </span>


            <span
                class="amr29-goal-muted"
            >

                /

                <span
                    id="amr29-goal-target"
                >
                    0
                </span>

                บาท

            </span>

        </div>


        <div
            class="amr29-goal-track"
        >

            <div
                id="amr29-goal-bar"
            ></div>


            <div
                id="amr29-goal-spark"
            ></div>

        </div>


        <div
            id="amr29-goal-note"
        >
            กำลังโหลด Goal...
        </div>

    `;


    /* ==============================
       INSERT POSITION
    ============================== */

    /*
        ถ้า index.html มี .page
        จะเอา Goal ไปใส่ด้านบนสุดของ .page
    */

    const page =
        document.querySelector(
            ".page"
        );


    if (page) {

        page.insertBefore(
            widget,
            page.firstChild
        );

    } else {

        /*
            ถ้าไม่มี .page
            จะเอาไปไว้บนสุดของ body
        */

        document.body.prepend(
            widget
        );
    }


    /* ==============================
       ELEMENTS
    ============================== */

    const titleElement =
        document.getElementById(
            "amr29-goal-title"
        );


    const currentElement =
        document.getElementById(
            "amr29-goal-current"
        );


    const targetElement =
        document.getElementById(
            "amr29-goal-target"
        );


    const percentElement =
        document.getElementById(
            "amr29-goal-percent"
        );


    const barElement =
        document.getElementById(
            "amr29-goal-bar"
        );


    const sparkElement =
        document.getElementById(
            "amr29-goal-spark"
        );


    const noteElement =
        document.getElementById(
            "amr29-goal-note"
        );


    /* ==============================
       NUMBER FORMAT
    ============================== */

    function formatMoney(value) {

        const number =
            Number(value || 0);


        return number
            .toLocaleString(
                "th-TH",
                {
                    maximumFractionDigits:
                        2
                }
            );
    }


    /* ==============================
       RENDER GOAL
    ============================== */

    function renderGoal(goal) {

        widget.classList.remove(
            "loading"
        );


        /* --------------------------
           ENABLE / DISABLE
        -------------------------- */

        if (
            goal.enabled === false
        ) {

            widget.style.display =
                "none";

            return;
        }


        widget.style.display =
            "";


        /* --------------------------
           DATA
        -------------------------- */

        const total =
            Number(
                goal.total || 0
            );


        const target =
            Math.max(

                1,

                Number(
                    goal.target || 1
                )
            );


        const calculatedPercent =

            (
                total /
                target
            ) * 100;


        const percent =
            Math.min(

                100,

                Number.isFinite(
                    calculatedPercent
                )

                    ? calculatedPercent

                    : 0
            );


        /* --------------------------
           TITLE
        -------------------------- */

        titleElement.textContent =

            goal.title ||

            "เป้าหมายสนับสนุน";


        /* --------------------------
           MONEY
        -------------------------- */

        currentElement.textContent =
            formatMoney(
                total
            );


        targetElement.textContent =
            formatMoney(
                target
            );


        /* --------------------------
           PERCENT
        -------------------------- */

        percentElement.textContent =

            Math.round(
                percent
            ) + "%";


        /* --------------------------
           PROGRESS
        -------------------------- */

        barElement.style.width =
            percent + "%";


        sparkElement.style.left =
            percent + "%";


        sparkElement.style.opacity =

            percent > 0

                ? "1"

                : "0";


        /* ==============================
           COMPLETE
        ============================== */

        if (
            total >= target
        ) {

            widget.classList.add(
                "complete"
            );


            noteElement.textContent =
                "🎉 เป้าหมายสำเร็จแล้ว ขอบคุณทุกการสนับสนุน ❤️";


            return;
        }


        widget.classList.remove(
            "complete"
        );


        /* ==============================
           REMAINING
        ============================== */

        const remaining =
            Math.max(

                0,

                target -
                total
            );


        noteElement.textContent =

            `เหลืออีก ${formatMoney(remaining)} บาท ถึงเป้าหมาย`;
    }


    /* ==============================
       ERROR
    ============================== */

    function showError() {

        widget.classList.remove(
            "loading"
        );


        noteElement.textContent =
            "โหลด Donation Goal ไม่สำเร็จ";


        sparkElement.style.opacity =
            "0";
    }


    /* ==============================
       LOAD GOAL
    ============================== */

    async function loadGoal() {

        try {

            const response =
                await fetch(
                    "/api/goal",
                    {
                        cache:
                            "no-store"
                    }
                );


            const data =
                await response.json();


            if (
                !response.ok ||
                !data.success
            ) {

                throw new Error(
                    "Goal API Error"
                );
            }


            renderGoal(
                data
            );


        } catch (error) {

            console.error(
                "Donation Goal Error:",
                error
            );


            showError();
        }
    }


    /* ==============================
       SOCKET.IO REALTIME
    ============================== */

    function connectSocket() {

        if (
            typeof window.io !==
            "function"
        ) {

            console.warn(
                "Socket.IO ยังไม่พร้อม"
            );

            return;
        }


        const goalSocket =
            window.io();


        goalSocket.on(
            "connect",
            () => {

                console.log(
                    "Donation Goal connected"
                );
            }
        );


        goalSocket.on(
            "goal-update",
            (goal) => {

                console.log(
                    "Goal updated:",
                    goal
                );


                renderGoal(
                    goal
                );
            }
        );


        goalSocket.on(
            "disconnect",
            () => {

                console.log(
                    "Donation Goal disconnected"
                );
            }
        );
    }


    /* ==============================
       START
    ============================== */

    loadGoal();


    /*
        ถ้า index.html โหลด Socket.IO
        อยู่แล้ว ก็ใช้ได้เลย
    */

    if (
        typeof window.io ===
        "function"
    ) {

        connectSocket();

    } else {

        /*
            ถ้ายังไม่มี Socket.IO
            goal-widget โหลดให้อัตโนมัติ
        */

        const socketScript =
            document.createElement(
                "script"
            );


        socketScript.src =
            "/socket.io/socket.io.js";


        socketScript.onload =
            () => {

                connectSocket();

            };


        socketScript.onerror =
            () => {

                console.error(
                    "โหลด Socket.IO ไม่สำเร็จ"
                );

            };


        document.head.appendChild(
            socketScript
        );
    }

})();