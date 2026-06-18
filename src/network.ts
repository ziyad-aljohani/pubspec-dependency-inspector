import axios, { AxiosResponse } from "axios";
import { Dependency } from "./analyze_dependencies";
import { getCachedPackageData, setCachedPackageData } from "./cache";

export async function fetchDependency(
    dependencies: Dependency
): Promise<AxiosResponse<any, any> | null> {
    const packageName = dependencies.name;

    const cachedData = getCachedPackageData(packageName);
    if (cachedData) {
        return { data: cachedData } as AxiosResponse<any, any>;
    }

    const url = `https://pub.dev/api/packages/${packageName}`;

    try {
        const response = await axios.get(url);
        setCachedPackageData(packageName, response.data);
        return response;

    } catch (error) {
        console.error(
            `Failed to fetch package information for ${packageName}:`,
            error
        );
        return null;
    }
}
