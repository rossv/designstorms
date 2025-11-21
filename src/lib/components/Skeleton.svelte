<script lang="ts">
    export let width = "100%";
    export let height = "1rem";
    export let borderRadius = "4px";
    export let className = "";
</script>

<div
    class="skeleton {className}"
    style="width: {width}; height: {height}; border-radius: {borderRadius};"
    aria-hidden="true"
></div>

<style>
    .skeleton {
        background: var(--surface-subtle, rgba(255, 255, 255, 0.1));
        position: relative;
        overflow: hidden;
    }

    .skeleton::after {
        content: "";
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        left: 0;
        transform: translateX(-100%);
        background-image: linear-gradient(
            90deg,
            rgba(255, 255, 255, 0) 0,
            rgba(255, 255, 255, 0.05) 20%,
            rgba(255, 255, 255, 0.1) 60%,
            rgba(255, 255, 255, 0)
        );
        animation: shimmer 2s infinite;
    }

    @keyframes shimmer {
        100% {
            transform: translateX(100%);
        }
    }
</style>
