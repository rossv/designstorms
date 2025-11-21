<script lang="ts">
    export let size = 24;
    export let color = "var(--accent)";
    export let strokeWidth = 3;
</script>

<div
    class="spinner"
    style="width: {size}px; height: {size}px; --spinner-color: {color}; --stroke-width: {strokeWidth}px"
    role="status"
    aria-label="Loading"
>
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <circle class="track" cx="12" cy="12" r="10" />
        <circle class="car" cx="12" cy="12" r="10" />
    </svg>
</div>

<style>
    .spinner {
        display: inline-block;
        position: relative;
    }

    svg {
        animation: rotate 2s linear infinite;
        width: 100%;
        height: 100%;
    }

    circle {
        fill: none;
        stroke-width: var(--stroke-width);
        stroke-linecap: round;
    }

    .track {
        stroke: var(--spinner-color);
        opacity: 0.2;
    }

    .car {
        stroke: var(--spinner-color);
        stroke-dasharray: 1, 200;
        stroke-dashoffset: 0;
        animation: dash 1.5s ease-in-out infinite;
    }

    @keyframes rotate {
        100% {
            transform: rotate(360deg);
        }
    }

    @keyframes dash {
        0% {
            stroke-dasharray: 1, 200;
            stroke-dashoffset: 0;
        }
        50% {
            stroke-dasharray: 89, 200;
            stroke-dashoffset: -35px;
        }
        100% {
            stroke-dasharray: 89, 200;
            stroke-dashoffset: -124px;
        }
    }
</style>
